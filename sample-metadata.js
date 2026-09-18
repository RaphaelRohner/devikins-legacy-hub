/**
 * sample-metadata.js
 *
 * Samples the Devikins metadata API across all three collections (characters,
 * weapons, equipment) to map out every trait_type that exists, which ones
 * are universal vs occasional, numeric ranges, and categorical value sets.
 *
 * Uses the retry-with-backoff + concurrency-capped fetcher from
 * klever-nft-fetch.js (same folder) so we're gentle with the flaky Lambda:
 * 1s/2s/4s backoff, max 4 requests in flight at once.
 *
 * What it does:
 *   1. Picks 30 nonces per collection, evenly spaced from 1 up to that
 *      collection's known minted count (so you get low/mid/high coverage,
 *      not just the first 30 tokens ever minted).
 *   2. Fetches each one (with retry+backoff), saving every successful raw
 *      response to  metadata-samples/<collection>/<nonce>.json
 *      and every failure to metadata-samples/<collection>/_failures.json
 *   3. Aggregates trait_type stats across the successful fetches and writes
 *      metadata-samples/summary.json (machine-readable) and
 *      metadata-samples/summary.md (human-readable) with:
 *        - every trait_type seen per collection + how many items had it
 *        - numeric vs categorical
 *        - min/max for numeric traits (flags negatives)
 *        - distinct values for categorical traits
 *        - naming mismatches between collections (e.g. "ImprovementLevel"
 *          vs "Improvement Level")
 *
 * Run it from a normal Terminal (needs real internet access):
 *   cd ~/Documents/devikins-app
 *   node sample-metadata.js
 *
 * It can take a while (the Lambda is slow/flaky) - that's expected.
 */

const fs = require('fs');
const path = require('path');
const { fetchNftMetadataBatch } = require('./klever-nft-fetch');

// Known minted counts per collection (from the Klever asset endpoint,
// checked 2026-09-17). Used only to pick a spread of nonces to sample -
// doesn't need to be exact.
const MAX_NONCE = {
  characters: 1130685,
  weapons: 63209,
  equipment: 52694,
};

const SAMPLE_SIZE = 30;
const CONCURRENCY = 4; // "no more than 3-5 parallel requests"

const OUTPUT_DIR = path.join(__dirname, 'metadata-samples');

// ---- Helpers ----

function evenlySpacedNonces(max, count) {
  const nonces = [];
  for (let i = 0; i < count; i++) {
    const nonce = Math.round(1 + (i * (max - 1)) / (count - 1));
    nonces.push(nonce);
  }
  return Array.from(new Set(nonces)); // dedupe, just in case of rounding collisions
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function normalizeTraitKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Walk one collection's successful metadata responses and build a per-trait
 * summary: how many items had it, numeric vs categorical, min/max or
 * distinct values.
 */
function summarizeCollection(items) {
  const traits = {}; // trait_type -> { seenCount, isNumeric, values:Set, min, max }

  for (const { metadata } of items) {
    if (!metadata || !Array.isArray(metadata.attributes)) continue;

    for (const attr of metadata.attributes) {
      const key = attr.trait_type;
      if (!key) continue;

      if (!traits[key]) {
        traits[key] = {
          seenCount: 0,
          numericCount: 0,
          categoricalCount: 0,
          values: new Set(),
          min: null,
          max: null,
        };
      }

      const t = traits[key];
      t.seenCount += 1;

      const isNumeric = attr.display_type === 'number' && typeof attr.value === 'number';
      if (isNumeric) {
        t.numericCount += 1;
        t.min = t.min === null ? attr.value : Math.min(t.min, attr.value);
        t.max = t.max === null ? attr.value : Math.max(t.max, attr.value);
      } else {
        t.categoricalCount += 1;
        t.values.add(String(attr.value));
      }
    }
  }

  // Convert to a plain-object, JSON-friendly shape
  const result = {};
  for (const [key, t] of Object.entries(traits)) {
    const mostlyNumeric = t.numericCount > 0 && t.categoricalCount === 0;
    const mixed = t.numericCount > 0 && t.categoricalCount > 0;
    result[key] = {
      seenCount: t.seenCount,
      type: mixed ? 'MIXED (inconsistent!)' : mostlyNumeric ? 'number' : 'categorical',
      ...(mostlyNumeric || mixed ? { min: t.min, max: t.max, hasNegative: t.min !== null && t.min < 0 } : {}),
      ...(!mostlyNumeric ? { distinctValues: Array.from(t.values).sort() } : {}),
    };
  }
  return result;
}

function findNamingInconsistencies(perCollectionTraits) {
  // normalized key -> { collection -> Set(original spellings) }
  const byNormalized = {};

  for (const [collection, traits] of Object.entries(perCollectionTraits)) {
    for (const rawKey of Object.keys(traits)) {
      const norm = normalizeTraitKey(rawKey);
      if (!byNormalized[norm]) byNormalized[norm] = {};
      if (!byNormalized[norm][collection]) byNormalized[norm][collection] = new Set();
      byNormalized[norm][collection].add(rawKey);
    }
  }

  const inconsistencies = [];
  for (const [norm, collections] of Object.entries(byNormalized)) {
    const allSpellings = new Set();
    for (const set of Object.values(collections)) {
      for (const spelling of set) allSpellings.add(spelling);
    }
    if (allSpellings.size > 1) {
      const variants = {};
      for (const [collection, set] of Object.entries(collections)) {
        variants[collection] = Array.from(set);
      }
      inconsistencies.push({ normalized: norm, variants });
    }
  }
  return inconsistencies;
}

function toMarkdown(summary) {
  let md = `# Devikins metadata trait survey\n\nGenerated ${new Date().toISOString()}\n\n`;

  for (const [collection, data] of Object.entries(summary.collections)) {
    md += `## ${collection}\n\n`;
    md += `Sampled ${data.sampledNonces.length} nonces, ${data.successCount} succeeded, ${data.failureCount} failed after retries.\n\n`;
    md += `| Trait | Seen | Type | Min | Max | Negative? | Distinct values |\n`;
    md += `|---|---|---|---|---|---|---|\n`;
    for (const [trait, t] of Object.entries(data.traits)) {
      md += `| ${trait} | ${t.seenCount}/${data.successCount} | ${t.type} | ${t.min ?? ''} | ${t.max ?? ''} | ${t.hasNegative ? 'YES' : ''} | ${t.distinctValues ? t.distinctValues.join(', ') : ''} |\n`;
    }
    md += `\n`;
    if (data.failures.length) {
      md += `Failed nonces: ${data.failures.map((f) => f.nonce).join(', ')}\n\n`;
    }
  }

  if (summary.namingInconsistencies.length) {
    md += `## Naming inconsistencies between collections\n\n`;
    for (const inc of summary.namingInconsistencies) {
      md += `- ${JSON.stringify(inc.variants)}\n`;
    }
  } else {
    md += `## Naming inconsistencies between collections\n\nNone found.\n`;
  }

  return md;
}

// ---- Main ----

async function run() {
  ensureDir(OUTPUT_DIR);

  const collections = ['characters', 'weapons', 'equipment'];
  const summary = { collections: {}, namingInconsistencies: [] };
  const perCollectionTraits = {};

  for (const collection of collections) {
    console.log(`\n=== Sampling ${collection} ===`);
    const collectionDir = path.join(OUTPUT_DIR, collection);
    ensureDir(collectionDir);

    const nonces = evenlySpacedNonces(MAX_NONCE[collection], SAMPLE_SIZE);
    console.log(`Nonces: ${nonces.join(', ')}`);

    const results = await fetchNftMetadataBatch(collection, nonces, { concurrency: CONCURRENCY });

    const successes = [];
    const failures = [];

    for (const result of results) {
      if (result.metadata) {
        successes.push(result);
        fs.writeFileSync(
          path.join(collectionDir, `${result.nonce}.json`),
          JSON.stringify(result.metadata, null, 2)
        );
      } else {
        failures.push({ nonce: result.nonce, error: result.error });
      }
    }

    if (failures.length) {
      fs.writeFileSync(path.join(collectionDir, '_failures.json'), JSON.stringify(failures, null, 2));
    }

    const traits = summarizeCollection(successes);
    perCollectionTraits[collection] = traits;

    summary.collections[collection] = {
      sampledNonces: nonces,
      successCount: successes.length,
      failureCount: failures.length,
      failures,
      traits,
    };

    console.log(`${collection}: ${successes.length}/${nonces.length} succeeded, ${failures.length} failed.`);
  }

  summary.namingInconsistencies = findNamingInconsistencies(perCollectionTraits);

  fs.writeFileSync(path.join(OUTPUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'summary.md'), toMarkdown(summary));

  console.log(`\nDone. Raw responses + summary.json + summary.md are in: ${OUTPUT_DIR}`);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
