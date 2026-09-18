/**
 * schema.js
 *
 * This file is the single source of truth for "what does a Devikins NFT
 * look like in our database". If you ever need to know which database
 * column a trait lives in, or add support for a brand-new trait the game
 * introduces later, THIS is the file to change.
 *
 * Why this exists as its own file: the database code, the code that saves
 * fetched NFTs, and the filter UI all need to agree on the same list of
 * columns. Keeping that list in one place means they can never disagree.
 *
 * Background reading: see NOTES.md in the project root for the full
 * research behind these numbers (which traits exist, their value ranges,
 * naming quirks between collections, etc).
 */

// The three Klever NFT collections this app cares about, and the two
// identifiers each one needs:
//   - assetId: the ID Klever's blockchain API uses to look up "who holds
//     this collection" (used when asking "what does this wallet own?")
//   - the object key itself (devikin / weapon / equipment) doubles as both
//     the metadata API's URL segment (e.g. GET /devikin/123) AND the name
//     of this collection's database table.
export const COLLECTIONS = {
  devikin: {
    assetId: 'DVKNFT-1SW5',
    label: 'Devikins',
  },
  weapon: {
    assetId: 'DVKWPNFT-169T',
    label: 'Weapons',
  },
  equipment: {
    assetId: 'DVKEQNFT-1Q56', // capital Q, not a zero!
    label: 'Equipment',
  },
};

/**
 * TRAIT_COLUMNS describes every known trait for every collection, and how
 * it should be stored:
 *
 *   traitTypes: the exact spelling(s) the metadata API uses for this trait
 *     in its `attributes` array. This is a LIST because sometimes the same
 *     concept is spelled differently between collections - for example
 *     weapons call it "ImprovementLevel" (no space) while equipment calls
 *     the very same idea "Improvement Level" (with a space). Both spellings
 *     get folded into one `improvement_level` database column so filtering
 *     works the same way regardless of which collection you're looking at.
 *
 *   kind: 'text' for categorical traits (Rarity, Type, ...), or 'integer'
 *     for numeric ones (stats, levels, ...). This decides both the SQLite
 *     column type AND which kind of filter control the app shows for it
 *     (a dropdown for text, a min/max range for integer).
 *
 *   filterable: most traits are worth letting the user filter by. A couple
 *     (like the raw image-icon file path) aren't really "traits" a person
 *     would filter on, so we mark those false. Everything else defaults to
 *     filterable.
 *
 * IMPORTANT: this list came from sampling real NFTs, not from official
 * documentation (none exists). It's very likely complete for the traits
 * that exist today, but the game could add new ones later. If that
 * happens, the app won't crash or lose data - see database.js's
 * `upsertNft` function, which logs any trait it doesn't recognize and
 * always keeps a full copy of the raw response so nothing is ever lost.
 * You'd just add a new entry here (and a matching one to
 * CREATE_TABLE_EXTRA_COLUMNS never needs manual editing - it derives from
 * this same object) to give a new trait its own filterable column.
 */
// The Rarity dropdown (shared by all three collections) reads better as
// an actual rarity ladder - lowest to highest - than alphabetical order
// (which would put "Common" after "Eldritch"). CollectionView.js applies
// this ordering specifically to the rarity column's filter options; every
// other text filter still just uses whatever order the database returns
// (alphabetical - see getDistinctColumnValues in database.js).
export const RARITY_ORDER = ['Common', 'Uncommon', 'Rare', 'Mythic', 'Eldritch'];

export const TRAIT_COLUMNS = {
  devikin: {
    rarity: { traitTypes: ['Rarity'], kind: 'text' },
    ancestry: { traitTypes: ['Ancestry'], kind: 'text' },
    personality: { traitTypes: ['Personality'], kind: 'text' },
    eyes_gene: { traitTypes: ['Eyes Gene'], kind: 'text' },
    mouth_gene: { traitTypes: ['Mouth Gene'], kind: 'text' },
    ears_gene: { traitTypes: ['Ears Gene'], kind: 'text' },
    hair_gene: { traitTypes: ['Hair Gene'], kind: 'text' },
    horns_gene: { traitTypes: ['Horns Gene'], kind: 'text' },
    life_stage: { traitTypes: ['Life Stage'], kind: 'text' },
    overall_affinity: { traitTypes: ['Overall Affinity'], kind: 'integer' },
    vitality_affinity: { traitTypes: ['Vitality Affinity'], kind: 'integer' },
    power_affinity: { traitTypes: ['Power Affinity'], kind: 'integer' },
    fortitude_affinity: { traitTypes: ['Fortitude Affinity'], kind: 'integer' },
    agility_affinity: { traitTypes: ['Agility Affinity'], kind: 'integer' },
    sanity_affinity: { traitTypes: ['Sanity Affinity'], kind: 'integer' },
    vitality_attribute: { traitTypes: ['Vitality Attribute'], kind: 'integer' },
    power_attribute: { traitTypes: ['Power Attribute'], kind: 'integer' },
    fortitude_attribute: { traitTypes: ['Fortitude Attribute'], kind: 'integer' },
    agility_attribute: { traitTypes: ['Agility Attribute'], kind: 'integer' },
    sanity_attribute: { traitTypes: ['Sanity Attribute'], kind: 'integer' },
    procreations_left: { traitTypes: ['Procreations Left'], kind: 'integer' },
  },

  weapon: {
    rarity: { traitTypes: ['Rarity'], kind: 'text' },
    type: { traitTypes: ['Type'], kind: 'text' },
    quality: { traitTypes: ['Quality'], kind: 'text' },
    shiny: { traitTypes: ['Shiny'], kind: 'text' },
    slot: { traitTypes: ['Slot'], kind: 'text' },
    element: { traitTypes: ['Element'], kind: 'text' },
    resistance_type: { traitTypes: ['Resistance Type'], kind: 'text' },
    gene_sync: { traitTypes: ['Gene Sync'], kind: 'text' },
    icon_image: { traitTypes: ['Icon Image'], kind: 'text', filterable: false },
    scaling: { traitTypes: ['Scaling'], kind: 'integer' },
    critical_chance: { traitTypes: ['Critical Chance'], kind: 'integer' },
    critical_damage: { traitTypes: ['Critical Damage'], kind: 'integer' },
    // Confirmed negative values are possible for these two - the filter
    // range inputs must NOT assume a minimum of zero.
    speed_modifier: { traitTypes: ['Speed Modifier'], kind: 'integer' },
    accuracy: { traitTypes: ['Accuracy'], kind: 'integer' },
    refine_xp: { traitTypes: ['Refine XP'], kind: 'integer' },
    base_durability: { traitTypes: ['Base Durability'], kind: 'integer' },
    durability: { traitTypes: ['Durability'], kind: 'integer' },
    // Weapons spell this "ImprovementLevel" - folded into the same column
    // equipment uses below, which spells it "Improvement Level".
    improvement_level: { traitTypes: ['ImprovementLevel', 'Improvement Level'], kind: 'integer' },
  },

  equipment: {
    rarity: { traitTypes: ['Rarity'], kind: 'text' },
    type: { traitTypes: ['Type'], kind: 'text' },
    quality: { traitTypes: ['Quality'], kind: 'text' },
    shiny: { traitTypes: ['Shiny'], kind: 'text' },
    slot: { traitTypes: ['Slot'], kind: 'text' },
    resistance_type: { traitTypes: ['Resistance Type'], kind: 'text' },
    icon_image: { traitTypes: ['Icon Image'], kind: 'text', filterable: false },
    protection: { traitTypes: ['Protection'], kind: 'integer' },
    evasion: { traitTypes: ['Evasion'], kind: 'integer' },
    guard: { traitTypes: ['Guard'], kind: 'integer' },
    resistance: { traitTypes: ['Resistance'], kind: 'integer' },
    accuracy: { traitTypes: ['Accuracy'], kind: 'integer' },
    improvement_level: { traitTypes: ['ImprovementLevel', 'Improvement Level'], kind: 'integer' },
    refine_xp: { traitTypes: ['Refine XP'], kind: 'integer' },
  },
};

// Every table also has these columns, in addition to whatever is in
// TRAIT_COLUMNS above. They're not "traits" - they're bookkeeping fields
// the app itself needs (which wallet had this NFT, when we last checked,
// whether the fetch worked, and the full original response as a safety
// net). See database.js for how these are used.
export const BASE_COLUMNS = ['nonce', 'owner_address', 'name', 'image', 'local_image_path', 'description', 'status', 'fetched_at', 'raw_json', 'deleted', 'comment'];
