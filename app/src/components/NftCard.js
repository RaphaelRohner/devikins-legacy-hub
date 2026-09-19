/**
 * NftCard.js
 *
 * Renders one row in the NFT list: its picture, name, nonce (its unique
 * token number), a status badge if something went wrong fetching it, and
 * a set of small "chips" showing every trait this specific item has a
 * value for.
 *
 * We deliberately show ALL of an item's known traits here rather than
 * picking just a few "important" ones - with 13-20 traits per item that
 * makes for a busy card, but it means you never have to tap into a
 * separate detail screen just to see a stat. If this ever feels too
 * cluttered, a natural improvement would be to only show a curated subset
 * here and put the rest behind a "show more" tap - but that's left for
 * later, this is the simple version.
 *
 * Devikins get a specifically-laid-out card, per feedback, instead of
 * the generic layout Weapons/Equipment use below:
 *
 *   [picture]   #1234 (ID)
 *               Procreations Left: 7
 *               Life Stage: Adult
 *               Overall Affinity: 34
 *   -------------------------------------
 *     Rarity      Ancestry     Personality
 *   -------------------------------------
 *   [Eyes/Mouth/Ears/Hair/Horns Gene chips]
 *   -------------------------------------
 *   Vitality Affinity    |  Vitality Attribute
 *   Power Affinity       |  Power Attribute
 *   Fortitude Affinity   |  Fortitude Attribute
 *   Agility Affinity     |  Agility Attribute
 *   Sanity Affinity      |  Sanity Attribute
 *   [any other stat this item has, as before]
 *
 * The specific traits in each section (topStatKeys/triStatKeys/
 * geneStatKeys/pairedStatKeys below) are called out by name rather than
 * derived from schema.js, because this particular arrangement is about
 * these SPECIFIC traits' meaning (genes together, core identity stats
 * together, each Affinity lined up with its matching Attribute) - not a
 * generic pattern that would keep making sense if the game added new
 * traits later. Anything not explicitly placed still shows up in the
 * catch-all row at the bottom, so nothing is ever hidden even though
 * this layout is hand-arranged.
 *
 * Weapons get a similar hand-arranged treatment (a first pass - happy to
 * adjust the grouping or fields on request):
 *
 *   [picture]   Name
 *               #1234 (nonce)
 *   -------------------------------------
 *     Rarity      Type         Quality
 *   -------------------------------------
 *   [Shiny/Slot/Element/Resistance Type/Gene Sync chips]
 *   -------------------------------------
 *   Scaling            | Critical Chance
 *   Critical Damage    | Speed Modifier
 *   Accuracy           | Refine XP
 *   -------------------------------------
 *   Base Durability   Durability   Improvement Level
 *   [any other stat this item has, as before]
 *
 * Equipment gets a similar treatment too (also a first pass):
 *
 *   [picture]   Name
 *               #1234 (nonce)
 *   -------------------------------------
 *     Rarity      Type         Quality
 *   -------------------------------------
 *   [Shiny/Slot/Resistance Type chips]
 *   -------------------------------------
 *   Protection   | Evasion
 *   Guard        | Resistance
 *   -------------------------------------
 *   Accuracy   Improvement Level   Refine XP
 *   [any other stat this item has, as before]
 */

import { useEffect, useState } from 'react';
import { View, Text, Image, TextInput, StyleSheet, Modal, TouchableOpacity } from 'react-native';
import { TRAIT_COLUMNS } from '../constants/schema';
import { setNftDeletedState, setNftCustomName, setNftStarRating } from '../db/database';
import { useTheme } from '../context/ThemeContext';
import StarRating from './StarRating';

// Turns a database column name like "critical_chance" into a readable
// label like "Critical Chance". This is ONLY for display - the actual
// column name used in the database and in filters stays snake_case.
function humanizeColumnName(columnName) {
  return columnName
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export default function NftCard({ kind, nft, onNftUpdated }) {
  const { colors } = useTheme();
  const traitColumns = TRAIT_COLUMNS[kind];
  const displayName = nft.name || `${kind} #${nft.nonce}`;

  // Only include a chip for traits this particular NFT actually has a
  // value for (many will be null - see database.js's upsertNft, which
  // only fills in the traits present in that NFT's own attributes list).
  const traitChips = Object.keys(traitColumns)
    .filter((columnName) => traitColumns[columnName].filterable !== false)
    .filter((columnName) => nft[columnName] !== null && nft[columnName] !== undefined)
    .map((columnName) => ({
      key: columnName,
      label: humanizeColumnName(columnName),
      value: String(nft[columnName]),
    }));

  const statusBadge = nft.status !== 'ok' && (
    <View
      style={[
        styles.statusBadge,
        { backgroundColor: nft.status === 'unavailable' ? colors.statusUnavailableBackground : colors.statusFailedBackground },
      ]}
    >
      <Text style={[styles.statusBadgeText, { color: colors.statusText }]}>
        {nft.status === 'unavailable' ? 'Details unavailable' : 'Fetch failed - will retry next time'}
      </Text>
    </View>
  );

  // Prefer the locally-downloaded copy of the image (see
  // src/api/imageStorage.js) over the original remote URL - it's already
  // on the phone, so it shows up instantly and doesn't depend on the
  // image host being reachable right now. Older rows fetched before this
  // caching existed won't have a local_image_path yet, so they fall back
  // to the remote URL until the next time they're re-fetched.
  const imageSource = nft.local_image_path || nft.image;

  // Some items have an imageSource (a URL, or an old local path) that no
  // longer actually loads - most often an item fetched a while ago that
  // never got a local copy cached, whose original remote image host has
  // since gone offline or moved. Without this check, a broken
  // imageSource would just render as a blank box instead of the clear
  // "Unavailable" message below. onError fires whenever the Image fails
  // to load; the effect resets that flag back to false whenever
  // imageSource itself changes (e.g. once a background retry
  // successfully caches a local copy), so a since-fixed image gets a
  // fresh chance to load instead of being stuck showing the placeholder
  // forever.
  const [imageLoadFailed, setImageLoadFailed] = useState(false);
  useEffect(() => {
    setImageLoadFailed(false);
  }, [imageSource]);

  // Whether the fullscreen image viewer (see fullscreenModal below) is
  // currently open. Only ever one image showing per card, so one flag is
  // enough even though `image`/`largeImage` below both feed the same
  // viewer.
  const [isFullscreenVisible, setIsFullscreenVisible] = useState(false);

  const hasViewableImage = imageSource && !imageLoadFailed;

  const image = hasViewableImage ? (
    <TouchableOpacity onPress={() => setIsFullscreenVisible(true)} activeOpacity={0.85}>
      <Image
        source={{ uri: imageSource }}
        style={styles.thumbnail}
        resizeMode="contain"
        onError={() => setImageLoadFailed(true)}
      />
    </TouchableOpacity>
  ) : (
    <View style={[styles.thumbnail, styles.thumbnailPlaceholder, { backgroundColor: colors.placeholderBackground }]}>
      <Text style={[styles.thumbnailPlaceholderText, { color: colors.placeholderText }]}>Unavailable</Text>
    </View>
  );

  // A 100%-larger version of the same image, used only in the Devikin
  // detail view's top row (per feedback) - shares imageSource/
  // imageLoadFailed/setImageLoadFailed with `image` above rather than
  // re-computing anything, since only one of the two is ever actually
  // rendered for a given card.
  const largeImage = hasViewableImage ? (
    <TouchableOpacity onPress={() => setIsFullscreenVisible(true)} activeOpacity={0.85}>
      <Image
        source={{ uri: imageSource }}
        style={styles.thumbnailLarge}
        resizeMode="contain"
        onError={() => setImageLoadFailed(true)}
      />
    </TouchableOpacity>
  ) : (
    <View style={[styles.thumbnailLarge, styles.thumbnailPlaceholder, { backgroundColor: colors.placeholderBackground }]}>
      <Text style={[styles.thumbnailPlaceholderTextLarge, { color: colors.placeholderText }]}>Unavailable</Text>
    </View>
  );

  // Tapping either image above opens this: a plain full-screen overlay
  // (Modal, a component React Native provides for exactly this - content
  // that should cover the whole screen regardless of where it's placed
  // in the component tree below) showing the picture as large as
  // possible, with an explicit "✕" button plus tapping anywhere else to
  // close. Built once here and reused by every kind's layout below,
  // since only one image is ever showing per card.
  const fullscreenModal = hasViewableImage && (
    <Modal
      visible={isFullscreenVisible}
      transparent
      animationType="fade"
      onRequestClose={() => setIsFullscreenVisible(false)}
    >
      <TouchableOpacity
        style={styles.fullscreenBackdrop}
        activeOpacity={1}
        onPress={() => setIsFullscreenVisible(false)}
      >
        <Image source={{ uri: imageSource }} style={styles.fullscreenImage} resizeMode="contain" />
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.fullscreenCloseButton}
        onPress={() => setIsFullscreenVisible(false)}
      >
        <Text style={styles.fullscreenCloseButtonText}>✕</Text>
      </TouchableOpacity>
    </Modal>
  );

  // Every NFT can be marked "deleted" (hidden from the main list, see
  // CollectionView.js's "Deleted" filter switch and the summary rows'
  // greyed-out styling) with an optional free-text note attached - e.g.
  // "sold this on the marketplace" or "duplicate, keeping the other one".
  // This isn't a real delete - nothing is removed from the database, it's
  // just a flag + a note, so it's always reversible via the Restore button
  // below. `commentDraft` is a local, editable copy of nft.comment so
  // typing doesn't save on every keystroke - only tapping Mark as Deleted
  // or Restore actually writes it, at which point `onNftUpdated` (passed
  // in by CollectionView) reloads the list so the change shows up right
  // away (e.g. the item turning grey, or dropping out of the list if the
  // Deleted switch is on).
  const [commentDraft, setCommentDraft] = useState(nft.comment ?? '');
  useEffect(() => {
    setCommentDraft(nft.comment ?? '');
  }, [nft.nonce]);

  const isDeleted = Boolean(nft.deleted);

  async function handleMarkDeleted() {
    await setNftDeletedState(kind, nft.nonce, true, commentDraft.trim() || null);
    onNftUpdated?.();
  }

  async function handleRestore() {
    await setNftDeletedState(kind, nft.nonce, false, commentDraft.trim() || null);
    onNftUpdated?.();
  }

  // V2: a nickname the user can give this specific NFT, separate from
  // `name` above (the in-game name pulled straight from the fetched
  // metadata, never hand-edited) - stored in the `custom_name` column
  // (see database.js's initDatabase/setNftCustomName) and searchable
  // from the top search bar in App.js. Same "local draft, commit on a
  // deliberate action" pattern as commentDraft above, except the
  // deliberate action here is simply leaving the field (onEndEditing)
  // rather than a separate button - a plain rename doesn't carry the
  // same weight as marking something deleted, so it doesn't need its
  // own button to feel intentional.
  const [customNameDraft, setCustomNameDraft] = useState(nft.custom_name ?? '');
  useEffect(() => {
    setCustomNameDraft(nft.custom_name ?? '');
  }, [nft.nonce]);

  async function handleCustomNameCommit() {
    if ((nft.custom_name ?? '') === customNameDraft) return; // nothing changed
    await setNftCustomName(kind, nft.nonce, customNameDraft);
    onNftUpdated?.();
  }

  // V2: an optional 1-5 star rating, stored in the `star_rating` column
  // (see database.js's setNftStarRating) - unlike the name above, this
  // saves the moment a star is tapped rather than needing its own commit
  // step, since picking a rating IS the action (there's nothing further
  // to "finish typing").
  async function handleStarRatingChange(nextRating) {
    await setNftStarRating(kind, nft.nonce, nextRating);
    onNftUpdated?.();
  }

  // Shown in every detail layout below (devikin/weapon/equipment/
  // fallback all insert this same block), right after the item's own
  // traits/stats and right before deleteSection - per the V2 spec's
  // requested order: name and rating first, then notes/delete.
  const nameAndRatingSection = (
    <View style={styles.nameAndRatingSection}>
      <Text style={[styles.deleteSectionLabel, { color: colors.secondaryText }]}>Name</Text>
      <TextInput
        style={[styles.nameInput, { backgroundColor: colors.surfaceAlt, borderColor: colors.border, color: colors.text }]}
        placeholder="Give this NFT a name (optional)"
        placeholderTextColor={colors.secondaryText}
        value={customNameDraft}
        onChangeText={setCustomNameDraft}
        onEndEditing={handleCustomNameCommit}
      />
      <Text style={[styles.deleteSectionLabel, { color: colors.secondaryText, marginTop: 12 }]}>Rating</Text>
      <StarRating
        value={nft.star_rating ?? 0}
        onChange={handleStarRatingChange}
        mode="cumulative"
        size={26}
      />
    </View>
  );

  // Shown at the bottom of every detail layout below (devikin/weapon/
  // equipment/fallback all insert this same block, right before
  // fullscreenModal) - built once here since it doesn't vary by kind.
  const deleteSection = (
    <View style={styles.deleteSection}>
      {isDeleted && (
        <View style={[styles.deletedBadge, { backgroundColor: colors.statusFailedBackground }]}>
          <Text style={[styles.deletedBadgeText, { color: colors.cancelText }]}>Marked as deleted</Text>
        </View>
      )}
      <Text style={[styles.deleteSectionLabel, { color: colors.secondaryText }]}>Notes</Text>
      <TextInput
        style={[styles.commentInput, { backgroundColor: colors.surfaceAlt, borderColor: colors.border, color: colors.text }]}
        placeholder="Add a note (optional)"
        placeholderTextColor={colors.secondaryText}
        value={commentDraft}
        onChangeText={setCommentDraft}
        multiline
      />
      {isDeleted ? (
        <TouchableOpacity style={[styles.deleteActionButton, { backgroundColor: colors.primary }]} onPress={handleRestore}>
          <Text style={[styles.deleteActionButtonText, { color: colors.primaryText }]}>Restore</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          style={[styles.deleteActionButton, { backgroundColor: colors.statusFailedBackground }]}
          onPress={handleMarkDeleted}
        >
          <Text style={[styles.deleteActionButtonText, { color: colors.cancelText }]}>Mark as Deleted</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  // --- Devikins: a specific hand-arranged layout - see the file comment
  // at the top for a diagram of what goes where. ---
  if (kind === 'devikin') {
    // Quick lookup so we can pull out specific traits by column name
    // instead of just looping over all of them in order.
    const chipByKey = {};
    for (const chip of traitChips) {
      chipByKey[chip.key] = chip;
    }

    const topStatKeys = ['procreations_left', 'life_stage', 'overall_affinity'];
    const triStatKeys = ['rarity', 'ancestry', 'personality'];
    const geneStatKeys = ['eyes_gene', 'mouth_gene', 'ears_gene', 'hair_gene', 'horns_gene'];

    // The five genes, arranged two per row (per feedback) instead of
    // letting them wrap freely - there's an odd number of them, so the
    // last row only has a left column; geneGridPairs' `null` marks that.
    const geneGridPairs = [
      ['eyes_gene', 'mouth_gene'],
      ['ears_gene', 'hair_gene'],
      ['horns_gene', null],
    ];

    // Each of these five stats comes in a matching Affinity/Attribute
    // pair (e.g. Vitality Affinity + Vitality Attribute) - shown as two
    // columns, affinity on the left and its matching attribute on the
    // right, one row per stat.
    const pairedStatKeys = [
      ['vitality_affinity', 'vitality_attribute'],
      ['power_affinity', 'power_attribute'],
      ['fortitude_affinity', 'fortitude_attribute'],
      ['agility_affinity', 'agility_attribute'],
      ['sanity_affinity', 'sanity_attribute'],
    ];

    const hasTopStats = topStatKeys.some((key) => chipByKey[key]);
    const hasTriStats = triStatKeys.some((key) => chipByKey[key]);
    const hasGeneStats = geneStatKeys.some((key) => chipByKey[key]);
    const hasPairedStats = pairedStatKeys.some(([left, right]) => chipByKey[left] || chipByKey[right]);

    // Everything else this item has a value for that isn't one of the
    // specifically-placed traits above - shown in the same catch-all
    // chip style Weapons/Equipment use, so nothing is ever hidden just
    // because this layout only explicitly arranges specific traits.
    const placedKeys = new Set([
      ...topStatKeys,
      ...triStatKeys,
      ...geneStatKeys,
      ...pairedStatKeys.flat(),
    ]);
    const remainingChips = traitChips.filter((chip) => !placedKeys.has(chip.key));

    return (
      <>
      <View style={[styles.card, { backgroundColor: colors.surface, shadowColor: colors.cardShadow }]}>
        <View style={styles.devikinTopRow}>
          {largeImage}
          <View style={styles.devikinTopRight}>
            <Text style={[styles.devikinId, { color: colors.text }]}>#{nft.nonce}</Text>
            {hasTopStats && topStatKeys.map((key) => chipByKey[key] && (
              <Text key={key} style={[styles.devikinSubLine, { color: colors.secondaryText }]}>
                {chipByKey[key].label}: {chipByKey[key].value}
              </Text>
            ))}
          </View>
        </View>

        {statusBadge}

        {hasTriStats && (
          <>
            <View style={[styles.separator, { backgroundColor: colors.border }]} />
            <View style={styles.triRow}>
              {triStatKeys.map((key) => chipByKey[key] && (
                <View key={key} style={styles.triColumn}>
                  <Text style={[styles.triLabel, { color: colors.secondaryText }]}>{chipByKey[key].label}</Text>
                  <Text style={[styles.triValue, { color: colors.text }]}>{chipByKey[key].value}</Text>
                </View>
              ))}
            </View>
          </>
        )}

        {hasGeneStats && (
          <>
            <View style={[styles.separator, { backgroundColor: colors.border }]} />
            <View style={styles.geneGrid}>
              {geneGridPairs.map(([leftKey, rightKey]) => {
                const leftChip = chipByKey[leftKey];
                const rightChip = rightKey ? chipByKey[rightKey] : null;
                if (!leftChip && !rightChip) return null;

                return (
                  <View key={leftKey} style={styles.geneGridRow}>
                    {leftChip ? (
                      <View style={[styles.geneGridCell, { backgroundColor: colors.chipBackground }]}>
                        <Text style={[styles.chipText, { color: colors.chipText }]}>
                          {leftChip.label}: {leftChip.value}
                        </Text>
                      </View>
                    ) : (
                      <View style={styles.geneGridCell} />
                    )}
                    {rightChip ? (
                      <View style={[styles.geneGridCell, { backgroundColor: colors.chipBackground }]}>
                        <Text style={[styles.chipText, { color: colors.chipText }]}>
                          {rightChip.label}: {rightChip.value}
                        </Text>
                      </View>
                    ) : (
                      <View style={styles.geneGridCell} />
                    )}
                  </View>
                );
              })}
            </View>
          </>
        )}

        {hasPairedStats && (
          <>
            <View style={[styles.separator, { backgroundColor: colors.border }]} />
            <View style={styles.pairedStatsBlock}>
              {pairedStatKeys.map(([leftKey, rightKey]) => {
                const leftChip = chipByKey[leftKey];
                const rightChip = chipByKey[rightKey];
                if (!leftChip && !rightChip) return null;

                return (
                  <View key={leftKey} style={styles.pairedStatRow}>
                    <Text style={[styles.pairedStatText, { color: colors.text }]}>
                      {leftChip ? `${leftChip.label}: ${leftChip.value}` : ''}
                    </Text>
                    <Text style={[styles.pairedStatText, { color: colors.text }]}>
                      {rightChip ? `${rightChip.label}: ${rightChip.value}` : ''}
                    </Text>
                  </View>
                );
              })}
            </View>
          </>
        )}

        {remainingChips.length > 0 && (
          <View style={styles.chipContainer}>
            {remainingChips.map((chip) => (
              <View key={chip.key} style={[styles.chip, { backgroundColor: colors.chipBackground }]}>
                <Text style={[styles.chipText, { color: colors.chipText }]}>
                  {chip.label}: {chip.value}
                </Text>
              </View>
            ))}
          </View>
        )}
        <View style={[styles.separator, { backgroundColor: colors.border }]} />
        {nameAndRatingSection}
        {deleteSection}
      </View>
        {fullscreenModal}
      </>
    );
  }

  // --- Weapons: a specific hand-arranged layout - see the file comment
  // at the top for a diagram of what goes where. Equipment still uses
  // the generic layout below (no instructions for it yet). ---
  if (kind === 'weapon') {
    const chipByKey = {};
    for (const chip of traitChips) {
      chipByKey[chip.key] = chip;
    }

    const triStatKeys = ['rarity', 'type', 'quality'];
    const extraChipKeys = ['shiny', 'slot', 'element', 'resistance_type', 'gene_sync'];

    // These five combat stats don't pair up conceptually the way
    // Devikins' Affinity/Attribute stats do - they're just shown two per
    // row, in the same order schema.js lists them, purely to save space.
    const statGridPairs = [
      ['scaling', 'critical_chance'],
      ['critical_damage', 'speed_modifier'],
      ['accuracy', 'refine_xp'],
    ];

    const durabilityKeys = ['base_durability', 'durability', 'improvement_level'];

    const hasTriStats = triStatKeys.some((key) => chipByKey[key]);
    const hasExtraChips = extraChipKeys.some((key) => chipByKey[key]);
    const hasStatGrid = statGridPairs.some(([left, right]) => chipByKey[left] || chipByKey[right]);
    const hasDurabilityStats = durabilityKeys.some((key) => chipByKey[key]);

    const placedKeys = new Set([
      ...triStatKeys,
      ...extraChipKeys,
      ...statGridPairs.flat(),
      ...durabilityKeys,
    ]);
    const remainingChips = traitChips.filter((chip) => !placedKeys.has(chip.key));

    return (
      <>
      <View style={[styles.card, { backgroundColor: colors.surface, shadowColor: colors.cardShadow }]}>
        <View style={styles.headerRow}>
          {image}
          <View style={styles.headerText}>
            <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>{displayName}</Text>
            <Text style={[styles.nonce, { color: colors.secondaryText }]}>#{nft.nonce}</Text>
          </View>
        </View>

        {statusBadge}

        {hasTriStats && (
          <>
            <View style={[styles.separator, { backgroundColor: colors.border }]} />
            <View style={styles.triRow}>
              {triStatKeys.map((key) => chipByKey[key] && (
                <View key={key} style={styles.triColumn}>
                  <Text style={[styles.triLabel, { color: colors.secondaryText }]}>{chipByKey[key].label}</Text>
                  <Text style={[styles.triValue, { color: colors.text }]}>{chipByKey[key].value}</Text>
                </View>
              ))}
            </View>
          </>
        )}

        {hasExtraChips && (
          <>
            <View style={[styles.separator, { backgroundColor: colors.border }]} />
            <View style={styles.chipContainer}>
              {extraChipKeys.map((key) => chipByKey[key] && (
                <View key={key} style={[styles.chip, { backgroundColor: colors.chipBackground }]}>
                  <Text style={[styles.chipText, { color: colors.chipText }]}>
                    {chipByKey[key].label}: {chipByKey[key].value}
                  </Text>
                </View>
              ))}
            </View>
          </>
        )}

        {hasStatGrid && (
          <>
            <View style={[styles.separator, { backgroundColor: colors.border }]} />
            <View style={styles.pairedStatsBlock}>
              {statGridPairs.map(([leftKey, rightKey]) => {
                const leftChip = chipByKey[leftKey];
                const rightChip = chipByKey[rightKey];
                if (!leftChip && !rightChip) return null;

                return (
                  <View key={leftKey} style={styles.pairedStatRow}>
                    <Text style={[styles.pairedStatText, { color: colors.text }]}>
                      {leftChip ? `${leftChip.label}: ${leftChip.value}` : ''}
                    </Text>
                    <Text style={[styles.pairedStatText, { color: colors.text }]}>
                      {rightChip ? `${rightChip.label}: ${rightChip.value}` : ''}
                    </Text>
                  </View>
                );
              })}
            </View>
          </>
        )}

        {hasDurabilityStats && (
          <>
            <View style={[styles.separator, { backgroundColor: colors.border }]} />
            <View style={styles.triRow}>
              {durabilityKeys.map((key) => chipByKey[key] && (
                <View key={key} style={styles.triColumn}>
                  <Text style={[styles.triLabel, { color: colors.secondaryText }]}>{chipByKey[key].label}</Text>
                  <Text style={[styles.triValue, { color: colors.text }]}>{chipByKey[key].value}</Text>
                </View>
              ))}
            </View>
          </>
        )}

        {remainingChips.length > 0 && (
          <View style={styles.chipContainer}>
            {remainingChips.map((chip) => (
              <View key={chip.key} style={[styles.chip, { backgroundColor: colors.chipBackground }]}>
                <Text style={[styles.chipText, { color: colors.chipText }]}>
                  {chip.label}: {chip.value}
                </Text>
              </View>
            ))}
          </View>
        )}
        <View style={[styles.separator, { backgroundColor: colors.border }]} />
        {nameAndRatingSection}
        {deleteSection}
      </View>
        {fullscreenModal}
      </>
    );
  }

  // --- Equipment: a specific hand-arranged layout - see the file
  // comment at the top for a diagram of what goes where. ---
  if (kind === 'equipment') {
    const chipByKey = {};
    for (const chip of traitChips) {
      chipByKey[chip.key] = chip;
    }

    const triStatKeys = ['rarity', 'type', 'quality'];
    const extraChipKeys = ['shiny', 'slot', 'resistance_type'];

    // Protection/Evasion/Guard/Resistance are the defensive stats every
    // piece of Equipment can have - shown two per row, same spirit as
    // Weapons' combat-stat grid.
    const statGridPairs = [
      ['protection', 'evasion'],
      ['guard', 'resistance'],
    ];

    // Accuracy, Improvement Level, and Refine XP are grouped together as
    // a final tri-row, the equipment equivalent of Weapons' durability
    // group - "stats about upgrading/using this item" rather than raw
    // defensive power.
    const upgradeStatKeys = ['accuracy', 'improvement_level', 'refine_xp'];

    const hasTriStats = triStatKeys.some((key) => chipByKey[key]);
    const hasExtraChips = extraChipKeys.some((key) => chipByKey[key]);
    const hasStatGrid = statGridPairs.some(([left, right]) => chipByKey[left] || chipByKey[right]);
    const hasUpgradeStats = upgradeStatKeys.some((key) => chipByKey[key]);

    const placedKeys = new Set([
      ...triStatKeys,
      ...extraChipKeys,
      ...statGridPairs.flat(),
      ...upgradeStatKeys,
    ]);
    const remainingChips = traitChips.filter((chip) => !placedKeys.has(chip.key));

    return (
      <>
      <View style={[styles.card, { backgroundColor: colors.surface, shadowColor: colors.cardShadow }]}>
        <View style={styles.headerRow}>
          {image}
          <View style={styles.headerText}>
            <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>{displayName}</Text>
            <Text style={[styles.nonce, { color: colors.secondaryText }]}>#{nft.nonce}</Text>
          </View>
        </View>

        {statusBadge}

        {hasTriStats && (
          <>
            <View style={[styles.separator, { backgroundColor: colors.border }]} />
            <View style={styles.triRow}>
              {triStatKeys.map((key) => chipByKey[key] && (
                <View key={key} style={styles.triColumn}>
                  <Text style={[styles.triLabel, { color: colors.secondaryText }]}>{chipByKey[key].label}</Text>
                  <Text style={[styles.triValue, { color: colors.text }]}>{chipByKey[key].value}</Text>
                </View>
              ))}
            </View>
          </>
        )}

        {hasExtraChips && (
          <>
            <View style={[styles.separator, { backgroundColor: colors.border }]} />
            <View style={styles.chipContainer}>
              {extraChipKeys.map((key) => chipByKey[key] && (
                <View key={key} style={[styles.chip, { backgroundColor: colors.chipBackground }]}>
                  <Text style={[styles.chipText, { color: colors.chipText }]}>
                    {chipByKey[key].label}: {chipByKey[key].value}
                  </Text>
                </View>
              ))}
            </View>
          </>
        )}

        {hasStatGrid && (
          <>
            <View style={[styles.separator, { backgroundColor: colors.border }]} />
            <View style={styles.pairedStatsBlock}>
              {statGridPairs.map(([leftKey, rightKey]) => {
                const leftChip = chipByKey[leftKey];
                const rightChip = chipByKey[rightKey];
                if (!leftChip && !rightChip) return null;

                return (
                  <View key={leftKey} style={styles.pairedStatRow}>
                    <Text style={[styles.pairedStatText, { color: colors.text }]}>
                      {leftChip ? `${leftChip.label}: ${leftChip.value}` : ''}
                    </Text>
                    <Text style={[styles.pairedStatText, { color: colors.text }]}>
                      {rightChip ? `${rightChip.label}: ${rightChip.value}` : ''}
                    </Text>
                  </View>
                );
              })}
            </View>
          </>
        )}

        {hasUpgradeStats && (
          <>
            <View style={[styles.separator, { backgroundColor: colors.border }]} />
            <View style={styles.triRow}>
              {upgradeStatKeys.map((key) => chipByKey[key] && (
                <View key={key} style={styles.triColumn}>
                  <Text style={[styles.triLabel, { color: colors.secondaryText }]}>{chipByKey[key].label}</Text>
                  <Text style={[styles.triValue, { color: colors.text }]}>{chipByKey[key].value}</Text>
                </View>
              ))}
            </View>
          </>
        )}

        {remainingChips.length > 0 && (
          <View style={styles.chipContainer}>
            {remainingChips.map((chip) => (
              <View key={chip.key} style={[styles.chip, { backgroundColor: colors.chipBackground }]}>
                <Text style={[styles.chipText, { color: colors.chipText }]}>
                  {chip.label}: {chip.value}
                </Text>
              </View>
            ))}
          </View>
        )}
        <View style={[styles.separator, { backgroundColor: colors.border }]} />
        {nameAndRatingSection}
        {deleteSection}
      </View>
        {fullscreenModal}
      </>
    );
  }

  // --- Fallback: plain image-left, chips-below layout for any collection
  // that doesn't have its own hand-arranged layout above yet. Nothing
  // currently reaches this - it's a safety net for if a new collection
  // is ever added before it gets a custom treatment. ---
  return (
    <>
    <View style={[styles.card, { backgroundColor: colors.surface, shadowColor: colors.cardShadow }]}>
      <View style={styles.headerRow}>
        {image}

        <View style={styles.headerText}>
          <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>{displayName}</Text>
          <Text style={[styles.nonce, { color: colors.secondaryText }]}>#{nft.nonce}</Text>
          {statusBadge}
        </View>
      </View>

      {traitChips.length > 0 && (
        <View style={styles.chipContainer}>
          {traitChips.map((chip) => (
            <View key={chip.key} style={[styles.chip, { backgroundColor: colors.chipBackground }]}>
              <Text style={[styles.chipText, { color: colors.chipText }]}>
                {chip.label}: {chip.value}
              </Text>
            </View>
          ))}
        </View>
      )}
      <View style={[styles.separator, { backgroundColor: colors.border }]} />
      {nameAndRatingSection}
      {deleteSection}
    </View>
      {fullscreenModal}
    </>
  );
}

const styles = StyleSheet.create({
  // The fullscreen image viewer opened by tapping a card's picture (see
  // fullscreenModal above). Deliberately NOT theme-aware (no light-mode
  // version) - a near-black backdrop is the standard look for this kind
  // of viewer regardless of the app's own light/dark setting, since the
  // point is to make the picture itself as easy to see as possible.
  fullscreenBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.95)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fullscreenImage: {
    width: '100%',
    height: '100%',
  },
  fullscreenCloseButton: {
    position: 'absolute',
    top: 48,
    right: 20,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fullscreenCloseButtonText: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: '700',
  },

  card: {
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    marginHorizontal: 12,
    shadowOpacity: 0.06,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  thumbnail: {
    // Enlarged to 200% of the original 56x56 size, per feedback.
    width: 112,
    height: 112,
    borderRadius: 12,
  },
  thumbnailPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbnailPlaceholderText: {
    // "Unavailable" is a much longer word than the old "?" placeholder
    // was, so this needs to be small enough to actually fit and wrap
    // inside the thumbnail box instead of overflowing it.
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: 6,
  },
  // A 100%-larger thumbnail, used only for the Devikin detail view's top
  // row (see `largeImage` above) - exactly double the standard
  // thumbnail's dimensions and border radius.
  thumbnailLarge: {
    width: 224,
    height: 224,
    borderRadius: 24,
  },
  thumbnailPlaceholderTextLarge: {
    fontSize: 26,
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: 12,
  },
  headerText: {
    marginLeft: 12,
    flex: 1,
  },
  name: {
    fontSize: 16,
    fontWeight: '600',
  },
  nonce: {
    // Enlarged to 200% of the original 12px, per feedback.
    fontSize: 24,
    marginTop: 4,
  },
  statusBadge: {
    marginTop: 4,
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  statusBadgeText: {
    fontSize: 11,
  },
  chipContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 10,
    gap: 6,
  },
  chip: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  chipText: {
    fontSize: 12,
  },

  // Devikin-specific layout - see the file comment at the top for a
  // diagram of the overall arrangement.
  devikinTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  devikinTopRight: {
    marginLeft: 12,
    flex: 1,
  },
  devikinId: {
    fontSize: 28,
    fontWeight: '700',
  },
  devikinSubLine: {
    fontSize: 14,
    marginTop: 4,
  },
  // The horizontal rule between sections.
  separator: {
    height: 1,
    marginVertical: 12,
  },
  triRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  triColumn: {
    flex: 1,
    alignItems: 'center',
  },
  triLabel: {
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  triValue: {
    fontSize: 14,
    fontWeight: '600',
    marginTop: 2,
  },

  // The five genes, two per row (see geneGridPairs above) - a plain grid
  // rather than the wrap-based chipContainer used elsewhere, so they
  // line up into clean columns instead of flowing freely.
  geneGrid: {
    gap: 8,
  },
  geneGridRow: {
    flexDirection: 'row',
    gap: 8,
  },
  geneGridCell: {
    flex: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },

  // The five Affinity/Attribute pairs: one row per stat, two columns
  // (affinity left, matching attribute right).
  pairedStatsBlock: {
    gap: 8,
  },
  pairedStatRow: {
    flexDirection: 'row',
  },
  pairedStatText: {
    flex: 1,
    fontSize: 13,
  },

  // The Name & Rating block - see nameAndRatingSection above. Sits right
  // above deleteSection (both visually and in the JSX), so this shares
  // deleteSection's top margin rather than needing its own.
  nameAndRatingSection: {
    marginTop: 4,
  },
  nameInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
  },
  // The "mark as deleted" + notes block at the bottom of every detail
  // view - see deleteSection above.
  deleteSection: {
    marginTop: 16,
  },
  deletedBadge: {
    alignSelf: 'flex-start',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginBottom: 8,
  },
  deletedBadgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  deleteSectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 4,
  },
  commentInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 60,
    textAlignVertical: 'top',
    fontSize: 14,
  },
  deleteActionButton: {
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 8,
  },
  deleteActionButtonText: {
    fontWeight: '600',
  },
});
