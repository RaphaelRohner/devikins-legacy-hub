/**
 * AlbumsView.js — Collectors Albums (27 Oct 2026)
 *
 * Players show chosen NFTs from one of their wallets, with a note on each
 * ("May event 2025 Bonded Yoda"); everyone can browse the albums, on the
 * website also without signing in. Decided with Raphael:
 *   - Only NFTs from a wallet whose owner proved it holds them: the wallet
 *     signs a short text naming the album (Klever extension / KLV Signer),
 *     and every viewer's Hub checks that signature and asks Klever whether
 *     each NFT is still in that wallet. No made-up collections, no in-game NFTs.
 *   - Anonymous by default: the album isn't linked to the chat nickname,
 *     unless the owner switches "Show my chat nickname" on. The wallet
 *     address IS visible (that's the proof), so the Hub says so first and
 *     suggests a separate showcase wallet.
 *   - Comments from visitors (and holders confirming them) come later.
 * 28 Oct 2026 (later): comments on NFTs by signed-in holders, who confirm or
 * dispute them ("✓ I can confirm" / "✗ not right"); the album's owner can
 * hide one in their album. "Message the owner": the owner answers under the
 * album's name and stays anonymous (album mailbox, messenger.js).
 * 28 Oct 2026 (Raphael): sections chosen by the owner, filters and sorting
 * for visitors, the picker by kind with "show more", pictures without
 * waiting for Moonlabs' data server, and no wallet / numbers / Kleverscan
 * links on the album screens (against casual stalking of holders).
 *
 * The album itself (signing, checking) is in app/chat/src/album.js; the
 * postman keeps them (app/chat/postman); making one needs the chat sign-in
 * (against spam) - see messenger.js "Collectors Albums".
 *
 * Screens inside this one: the list of albums -> one album; "My albums"
 * -> the editor (new or existing album).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Image, Switch, Alert, Platform, useWindowDimensions, Modal, Keyboard,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import useNftImage from '../hooks/useNftImage';
import NftCard from './NftCard';
import useKeepFocusedInputVisible from '../hooks/useKeepFocusedInputVisible';

/**
 * The keyboard's height while it's open (Android app). A pop-up window
 * (Modal) isn't shrunk with the rest of the app when the keyboard opens, so
 * it makes room itself (28 Oct 2026: the comment field was under the keyboard).
 */
function useKeyboardHeight(typing = false) {
  const [height, setHeight] = useState(0);
  // Website on a phone (28 Oct 2026, the Klever app's K5 browser): the keyboard covers the
  // page without shrinking it. The browser's "visual viewport" says how much is covered.
  const [covered, setCovered] = useState(0);
  const [startHeight] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 0));
  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    const show = Keyboard.addListener('keyboardDidShow', (e) => setHeight(e?.endCoordinates?.height || 0));
    const hide = Keyboard.addListener('keyboardDidHide', () => setHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || !window.visualViewport) return undefined;
    const vv = window.visualViewport;
    const measure = () => {
      const c = window.innerHeight - vv.height - vv.offsetTop;
      setCovered(c > 80 ? Math.round(c) : 0);
    };
    vv.addEventListener('resize', measure);
    vv.addEventListener('scroll', measure);
    measure();
    return () => { vv.removeEventListener('resize', measure); vv.removeEventListener('scroll', measure); };
  }, []);
  if (Platform.OS !== 'web') return height;
  if (covered) return covered;
  // Some in-app browsers say nothing at all: while typing on a touch screen whose page
  // didn't shrink either, count on the keyboard taking about the lower 42 %.
  if (typeof window === 'undefined' || !typing) return 0;
  const touch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0 && window.innerWidth < 900;
  const shrunk = window.innerHeight < startHeight - 100;
  return touch && !shrunk ? Math.round(window.innerHeight * 0.42) : 0;
}
import { COLLECTIONS, TRAIT_COLUMNS, RARITY_ORDER, gameNameOf } from '../constants/schema';
import { POSTMAN_URL, MAIL_CHECK_EVERY_MS } from '../constants/chat';
import { publicAlbums } from '../../chat/src/client.js';
import {
  MAX_ALBUM_ITEMS, MAX_ALBUM_TITLE, MAX_ALBUM_DESCRIPTION, MAX_ALBUM_NOTE, MAX_ALBUM_SECTION, albumPictureUrl, pictureFolderOf,
} from '../../chat/src/album.js';
import { fetchNftMetadata } from '../api/metadataApi';
import { holdsNft } from '../api/withdrawalTracker';
import { getMessenger } from '../api/chatStore';
import { signChatText, CHAT_WALLET } from '../api/chatWallet';
import { getWallets, queryNfts, getStoredNfts } from '../db/database';
import { openChatDock, openChatScreen } from '../web/chatDock';

const IS_WEB = Platform.OS === 'web';
const KINDS = Object.keys(COLLECTIONS);
/** The postman's albums, read without signing in. */
const reader = () => publicAlbums({ baseUrl: POSTMAN_URL });

const shortAddress = (a) => (a ? `${a.slice(0, 10)}…${a.slice(-6)}` : '');
const dateText = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** Runs `jobs` (functions returning promises) with at most `n` at a time (Klever's servers don't like crowds). */
async function runLimited(jobs, n, isStopped) {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length && !isStopped()) {
      const job = jobs[next];
      next += 1;
      await job().catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker));
}

export default function AlbumsView({ onClose }) {
  const { colors } = useTheme();
  // 'list' | 'album' | 'mine' | 'edit' | 'talk'
  const [view, setView] = useState('list');
  const [openKey, setOpenKey] = useState(null);
  const [editKey, setEditKey] = useState(null);
  const [backTo, setBackTo] = useState('list');
  // An album conversation: { album, side, thread, title, nickname } and where Back goes.
  const [talk, setTalk] = useState(null);
  const openTalk = (t, from) => { setTalk({ ...t, back: from }); setView('talk'); };

  const header = (title, onBack) => (
    <View style={styles.topRow}>
      <TouchableOpacity style={[styles.backButton, { backgroundColor: colors.primary }]} onPress={onBack} accessibilityLabel="Back">
        <Text style={[styles.backButtonText, { color: colors.primaryText }]}>‹</Text>
      </TouchableOpacity>
      <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{title}</Text>
    </View>
  );

  if (view === 'talk') {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        {header(talk.side === 'owner' ? `${talk.nickname || 'A player'} · ${talk.title || 'your album'}` : `Owner of "${talk.title || 'an album'}"`, () => setView(talk.back))}
        <AlbumTalk talk={talk} onThread={(thread) => setTalk((t) => ({ ...t, thread }))} />
      </View>
    );
  }
  if (view === 'album') {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        {header('Collectors Album', () => setView(backTo))}
        <AlbumDetail albumKey={openKey} onTalk={(t) => openTalk(t, 'album')} />
      </View>
    );
  }
  if (view === 'mine') {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        {header('My albums', () => setView('list'))}
        <MyAlbums
          onOpen={(key) => { setOpenKey(key); setBackTo('mine'); setView('album'); }}
          onEdit={(key) => { setEditKey(key); setView('edit'); }}
          onTalk={(t) => openTalk(t, 'mine')}
        />
      </View>
    );
  }
  if (view === 'edit') {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        {header(editKey ? 'Edit album' : 'New album', () => setView('mine'))}
        <AlbumEditor albumKey={editKey} onDone={() => setView('mine')} />
      </View>
    );
  }
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {header('Collectors Albums', onClose)}
      <AlbumList
        onOpen={(key) => { setOpenKey(key); setBackTo('list'); setView('album'); }}
        onMine={() => setView('mine')}
      />
    </View>
  );
}

// --- the list of everyone's albums ---------------------------------------------

function AlbumList({ onOpen, onMine }) {
  const { colors } = useTheme();
  const [albums, setAlbums] = useState(null);
  const [unread, setUnread] = useState(0);
  // New album messages (only for players signed in to the chat).
  useEffect(() => {
    let stopped = false;
    (async () => {
      const m = await getMessenger();
      if ((await m.status()).state !== 'ready') return;
      await m.collectAlbumTalk().catch(() => {});
      const n = (await m.albumConversations()).reduce((sum, t) => sum + t.unread, 0);
      if (!stopped) setUnread(n);
    })().catch(() => {});
    return () => { stopped = true; };
  }, []);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (before = null) => {
    setBusy(true);
    setError('');
    try {
      const r = await reader().list(before);
      setAlbums((old) => (before ? [...(old || []), ...r.albums] : r.albums));
      setMore(r.more);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.text, { color: colors.text }]}>
          Collections other players show, with their own notes. Every NFT in an album is checked: the wallet proved
          it's theirs, and the Hub asks Klever whether each NFT is still in it.
        </Text>
        <TouchableOpacity style={[styles.button, { backgroundColor: colors.primary, alignSelf: 'flex-start' }]} onPress={onMine} testID="albums-mine">
          <Text style={[styles.buttonText, { color: colors.primaryText }]}>{unread ? `My albums · ${unread} new message${unread === 1 ? '' : 's'}` : 'My albums'}</Text>
        </TouchableOpacity>
      </View>
      {error ? <Text style={[styles.note, styles.pad, { color: colors.text }]}>{error}</Text> : null}
      {albums && albums.length === 0 ? (
        <Text style={[styles.note, styles.pad, { color: colors.secondaryText }]}>No albums yet. Be the first: My albums › New album.</Text>
      ) : null}
      {(albums || []).map((a) => (
        <TouchableOpacity
          key={a.key}
          testID="album-row"
          style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
          onPress={() => onOpen(a.key)}
        >
          <Text style={[styles.albumTitle, { color: colors.text }]} numberOfLines={1}>{a.title}</Text>
          <Text style={[styles.note, { color: colors.secondaryText }]}>
            {a.name ? `by ${a.name}` : 'Anonymous collector'} · {a.count} NFT{a.count === 1 ? '' : 's'} · {dateText(a.updated)}
          </Text>
        </TouchableOpacity>
      ))}
      {busy ? <ActivityIndicator style={styles.pad} color={colors.primary} /> : null}
      {more && !busy ? (
        <TouchableOpacity style={[styles.button, styles.pad, { backgroundColor: colors.primary, alignSelf: 'center' }]} onPress={() => load(albums[albums.length - 1].updated)}>
          <Text style={[styles.buttonText, { color: colors.primaryText }]}>Show more</Text>
        </TouchableOpacity>
      ) : null}
    </ScrollView>
  );
}

// --- one album -----------------------------------------------------------------------

const SINGULAR = { devikin: 'Devikin', weapon: 'Weapon', equipment: 'Equipment' };
const SORTS = [
  { key: 'album', label: 'Album order' },
  { key: 'rarity', label: 'Rarest first' },
  { key: 'affinity', label: 'Overall affinity', kind: 'devikin' },
];

/** An NFT's traits from Moonlabs' metadata, under the Hub's own column names (rarity, ancestry, type …). */
function traitsFromMetadata(kind, metadata) {
  const out = {};
  const byType = {};
  for (const [column, def] of Object.entries(TRAIT_COLUMNS[kind] || {})) for (const t of def.traitTypes) byType[t] = column;
  for (const a of Array.isArray(metadata?.attributes) ? metadata.attributes : []) {
    if (byType[a.trait_type]) out[byType[a.trait_type]] = a.value ?? null;
  }
  return out;
}

const rarityRank = (r) => RARITY_ORDER.indexOf(r);

/**
 * One album, checked (its signature and the wallet's proof, publicAlbums.one).
 * Per NFT, three things load separately, each shown as soon as it's there
 * (28 Oct 2026 - before, one slow answer held up the whole card):
 *   - the picture: this Hub's stored copy if it has loaded that NFT itself,
 *     otherwise straight from Moonlabs' picture server (album.js
 *     albumPictureUrl), and only if that fails the address from Moonlabs' data;
 *   - the traits (name, rarity, ancestry …): stored copy, else Moonlabs' data,
 *     for the filters and sorting;
 *   - whether the wallet still holds it (Klever's node).
 * Deliberately NOT shown (Raphael, 28 Oct 2026): the wallet, the NFTs'
 * numbers and Kleverscan links - so casual visitors can't look the holder up
 * in one click. (It isn't hidden from someone determined: the data is public.)
 */
function AlbumDetail({ albumKey, onTalk }) {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const [album, setAlbum] = useState(null);
  const [error, setError] = useState('');
  // `${kind}/${nonce}` -> a stored row of this Hub, Moonlabs' metadata, true/false/null (held)
  const [stored, setStored] = useState({});
  const [meta, setMeta] = useState({});
  const [held, setHeld] = useState({});
  const [kindF, setKindF] = useState(null);
  const [rarityF, setRarityF] = useState(null);
  const [ancestryF, setAncestryF] = useState(null);
  const [sort, setSort] = useState('album');
  // Comments on the album's NFTs (everyone reads them), and what the viewer may do:
  // { ready (signed in to the chat), nickname, mine (my album), votes: { id: 1 | -1 } }
  const [comments, setComments] = useState([]);
  const [viewer, setViewer] = useState({ ready: false, nickname: null, mine: false, votes: {} });
  const [openId, setOpenId] = useState(null);

  // (comments first: a vote cast before a comment was edited no longer counts)
  const loadAll = useCallback(async () => {
    let list = [];
    try { list = await reader().comments(albumKey); setComments(list); } catch { /* (shown without comments) */ }
    try {
      const m = await getMessenger();
      const st = await m.status();
      setViewer({ ready: st.state === 'ready', nickname: st.nickname, mine: await m.isMyAlbum(albumKey), votes: await m.myCommentVotes(list) });
    } catch { /* (a visitor without the chat: read only) */ }
  }, [albumKey]);
  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    let stopped = false;
    (async () => {
      try {
        const a = await reader().one(albumKey);
        if (stopped) return;
        setAlbum(a);
        // What this Hub already has (e.g. the owner looking at their own album).
        const mine = {};
        for (const kind of KINDS) {
          const nonces = a.items.filter((i) => i.kind === kind).map((i) => i.nonce);
          const rows = await getStoredNfts(kind, nonces).catch(() => []);
          for (const r of rows) mine[`${kind}/${r.nonce}`] = r;
        }
        if (stopped) return;
        setStored(mine);
        const holderJobs = a.items.map((i) => async () => {
          const ok = await holdsNft(a.wallet, i.kind, i.nonce).catch(() => null);
          if (!stopped) setHeld((old) => ({ ...old, [`${i.kind}/${i.nonce}`]: ok }));
        });
        const metaJobs = a.items.filter((i) => !mine[`${i.kind}/${i.nonce}`]).map((i) => async () => {
          const r = await fetchNftMetadata(i.kind, i.nonce, () => stopped);
          if (!stopped) setMeta((old) => ({ ...old, [`${i.kind}/${i.nonce}`]: r.outcome === 'ok' ? r.metadata : false }));
        });
        await Promise.all([runLimited(holderJobs, 3, () => stopped), runLimited(metaJobs, 3, () => stopped)]);
      } catch (e) {
        if (!stopped) setError(e.message);
      }
    })();
    return () => { stopped = true; };
  }, [albumKey]);

  // Each item with what's known so far: { item, id, row (stored), metadata, traits, name }
  const entries = useMemo(() => (album?.items || []).map((item, index) => {
    const id = `${item.kind}/${item.nonce}`;
    const row = stored[id] || null;
    const metadata = meta[id] || null;
    const traits = row || traitsFromMetadata(item.kind, metadata);
    const name = gameNameOf({ name: row?.name ?? metadata?.name, nonce: item.nonce });
    return { item, id, index, row, metadata, traits, name };
  }), [album, stored, meta]);

  if (error) return <Text style={[styles.note, styles.pad, { color: colors.text }]}>{error}</Text>;
  if (!album) return <ActivityIndicator style={styles.pad} color={colors.primary} />;

  const kindsHere = KINDS.filter((k) => entries.some((e) => e.item.kind === k));
  const raritiesHere = RARITY_ORDER.filter((r) => entries.some((e) => e.traits.rarity === r && (!kindF || e.item.kind === kindF)));
  const ancestriesHere = [...new Set(entries.filter((e) => e.item.kind === 'devikin' && e.traits.ancestry).map((e) => e.traits.ancestry))].sort();
  const shown = entries.filter((e) => (!kindF || e.item.kind === kindF)
    && (!rarityF || e.traits.rarity === rarityF)
    && (!ancestryF || (e.item.kind === 'devikin' && e.traits.ancestry === ancestryF)));
  if (sort === 'rarity') shown.sort((a, b) => rarityRank(b.traits.rarity) - rarityRank(a.traits.rarity) || a.index - b.index);
  if (sort === 'affinity') shown.sort((a, b) => (Number(b.traits.overall_affinity) || -1) - (Number(a.traits.overall_affinity) || -1) || a.index - b.index);
  // Sections (in album order; NFTs without one first, without a heading).
  const groups = [];
  if (sort === 'album') {
    for (const e of shown) {
      const title = e.item.section || '';
      let g = groups.find((x) => x.title === title);
      if (!g) { g = { title, entries: [] }; if (title) groups.push(g); else groups.unshift(g); }
      g.entries.push(e);
    }
  } else {
    groups.push({ title: '', entries: shown });
  }
  const gone = entries.filter((e) => held[e.id] === false).length;
  const columns = width >= 900 ? 4 : width >= 600 ? 3 : 2;
  const filtered = kindF || rarityF || ancestryF;

  const chip = (label, active, onPress, testID) => (
    <TouchableOpacity
      key={label}
      testID={testID}
      onPress={onPress}
      style={[styles.chip, { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.chipBackground : 'transparent' }]}
    >
      <Text style={{ color: active ? colors.primary : colors.text, fontSize: 13, fontWeight: active ? '700' : '500' }}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.albumTitle, { color: colors.text }]} testID="album-title">{album.title}</Text>
        <Text style={[styles.note, { color: colors.secondaryText }]}>
          {album.name ? `by ${album.name}` : 'Anonymous collector'} · {album.items.length} NFT{album.items.length === 1 ? '' : 's'} · updated {dateText(album.updatedAt)}
        </Text>
        {album.description ? <Text style={[styles.text, { color: colors.text }]}>{album.description}</Text> : null}
        <Text style={[styles.note, { color: colors.secondaryText }]}>
          ✓ The owner proved with their wallet that these NFTs are theirs; the Hub checks that each one is still there.
        </Text>
        {gone ? (
          <Text style={[styles.note, { color: colors.text }]} testID="album-gone">
            {gone} of these NFTs {gone === 1 ? 'is' : 'are'} no longer in the owner's wallet (shown faded).
          </Text>
        ) : null}
        <Text style={[styles.note, { color: colors.secondaryText }]}>
          Tap an NFT to see it bigger and read or add comments (seasons, events, anything worth knowing).
        </Text>
        {viewer.mine ? null : viewer.ready ? (
          <TouchableOpacity
            style={[styles.smallButton, { borderColor: colors.primary, alignSelf: 'flex-start' }]}
            onPress={async () => {
              const thread = await (await getMessenger()).albumThreadWith(albumKey);
              onTalk({ album: albumKey, side: 'visitor', thread, title: album.title });
            }}
            testID="album-message-owner"
          >
            <Text style={{ color: colors.primary, fontWeight: '700' }}>✉ Message the owner</Text>
          </TouchableOpacity>
        ) : (
          <Text style={[styles.small, { color: colors.secondaryText }]}>
            Signed in to the chat, you can comment and write to the owner (who stays anonymous).
          </Text>
        )}
      </View>

      {album.items.length > 1 ? (
        <View style={[styles.filterBox, { borderColor: colors.border }]}>
          {kindsHere.length > 1 ? (
            <View style={styles.chipRow}>
              {chip('All kinds', !kindF, () => { setKindF(null); setRarityF(null); setAncestryF(null); }, 'album-filter-kind-all')}
              {kindsHere.map((k) => chip(COLLECTIONS[k].label, kindF === k, () => { setKindF(kindF === k ? null : k); setRarityF(null); setAncestryF(null); }, `album-filter-${k}`))}
            </View>
          ) : null}
          {raritiesHere.length > 1 ? (
            <View style={styles.chipRow}>
              {raritiesHere.map((r) => chip(r, rarityF === r, () => setRarityF(rarityF === r ? null : r), `album-filter-rarity-${r}`))}
            </View>
          ) : null}
          {ancestriesHere.length > 1 && kindF !== 'weapon' && kindF !== 'equipment' ? (
            <View style={styles.chipRow}>
              {ancestriesHere.map((a) => chip(a, ancestryF === a, () => setAncestryF(ancestryF === a ? null : a), `album-filter-ancestry-${a}`))}
            </View>
          ) : null}
          <View style={styles.chipRow}>
            {SORTS.filter((s) => !s.kind || kindsHere.includes(s.kind)).map((s) => chip(s.label, sort === s.key, () => setSort(s.key), `album-sort-${s.key}`))}
          </View>
          {filtered ? (
            <Text style={[styles.small, { color: colors.secondaryText }]} testID="album-shown-count">Showing {shown.length} of {album.items.length}</Text>
          ) : null}
        </View>
      ) : null}

      {groups.map((g) => (
        <View key={g.title || '-'}>
          {g.title ? <Text style={[styles.section, { color: colors.text }]} testID="album-section">{g.title}</Text> : null}
          <View style={styles.grid}>
            {g.entries.map((e) => (
              <AlbumItem
                key={e.id}
                entry={e}
                held={held[e.id]}
                columns={columns}
                comments={visibleComments(comments, e.item, viewer.mine)}
                onPress={() => setOpenId(e.id)}
              />
            ))}
          </View>
        </View>
      ))}
      {openId ? (
        <NftPanel
          entry={entries.find((e) => e.id === openId)}
          held={held[openId]}
          albumKey={albumKey}
          comments={visibleComments(comments, entries.find((e) => e.id === openId).item, viewer.mine)}
          viewer={viewer}
          onChanged={loadAll}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </ScrollView>
  );
}

/**
 * The comments on one NFT as this viewer sees them: hidden ones only for
 * the album's owner (marked); best confirmed first; `disputed` = more
 * "not right" than confirmations (folded away on the screen).
 */
function visibleComments(all, item, isOwner) {
  return all
    .filter((c) => c.kind === item.kind && c.nonce === item.nonce && (!c.hidden || isOwner))
    .map((c) => ({ ...c, disputed: c.disputes > c.confirms }))
    .sort((a, b) => (b.confirms - b.disputes) - (a.confirms - a.disputes) || a.at - b.at);
}

/** An album NFT's picture: stored copy > straight from Moonlabs' picture server > the address in Moonlabs' data. */
function NftPicture({ entry, style }) {
  const { colors } = useTheme();
  const { item, row, metadata } = entry;
  const direct = albumPictureUrl(item);
  const [directFailed, setDirectFailed] = useState(false);
  const source = row || (direct && !directFailed ? { image: direct } : metadata?.image ? { image: metadata.image } : null);
  const { imageSource, imageLoadFailed, onImageError } = useNftImage(source);
  useEffect(() => {
    if (imageLoadFailed && !row && direct && !directFailed && metadata?.image && metadata.image !== direct) setDirectFailed(true);
  }, [imageLoadFailed, row, direct, directFailed, metadata]);
  const loading = !imageSource && metadata === null && !row;
  return imageSource && !imageLoadFailed ? (
    <Image source={{ uri: imageSource }} style={style} resizeMode="contain" onError={onImageError} />
  ) : (
    <View style={[style, { backgroundColor: colors.placeholderBackground, alignItems: 'center', justifyContent: 'center' }]}>
      {loading ? <ActivityIndicator color={colors.primary} /> : <Text style={{ color: colors.placeholderText, fontSize: 12 }}>No picture</Text>}
    </View>
  );
}

const nftTitle = ({ item, traits, name }) => name
  || [traits.rarity, item.kind === 'devikin' ? traits.ancestry : traits.type, SINGULAR[item.kind]].filter(Boolean).join(' ');
const heldText = (held) => (held === true ? '✓ in the owner\'s wallet' : held === false ? 'no longer in the owner\'s wallet'
  : held === null ? "couldn't check the wallet" : 'checking the wallet…');

function AlbumItem({ entry, held, columns, comments, onPress }) {
  const { colors } = useTheme();
  const { item, traits } = entry;
  const details = [COLLECTIONS[item.kind].label, traits.rarity, item.kind === 'devikin' ? traits.ancestry : traits.type].filter(Boolean);
  const top = comments.find((c) => !c.disputed && !c.hidden);
  return (
    <TouchableOpacity
      testID="album-item"
      onPress={onPress}
      style={[styles.item, { width: `${100 / columns - 2}%`, backgroundColor: colors.surface, borderColor: colors.border }, held === false && { opacity: 0.45 }]}
    >
      <NftPicture entry={entry} style={styles.itemImage} />
      <Text style={[styles.itemName, { color: colors.text }]} numberOfLines={1}>{nftTitle(entry)}</Text>
      <Text style={[styles.small, { color: colors.secondaryText }]} numberOfLines={2}>{details.join(' · ')}</Text>
      <Text style={[styles.small, { color: held === false ? colors.text : colors.secondaryText }]} testID="album-item-held">{heldText(held)}</Text>
      {item.note ? <Text style={[styles.small, { color: colors.text, fontStyle: 'italic' }]}>{item.note}</Text> : null}
      {comments.length ? (
        <Text style={[styles.small, { color: colors.secondaryText }]} numberOfLines={2} testID="album-item-comments">
          💬 {comments.length}{top ? ` · ${top.text}${top.confirms ? ` (✓ ${top.confirms})` : ''}` : ''}
        </Text>
      ) : null}
    </TouchableOpacity>
  );
}

/**
 * One NFT of an album, bigger, with its comments. Signed-in players comment
 * and vote (✓ I can confirm / ✗ not right; not on their own); writers delete
 * their own; the album's owner hides a comment in their album.
 */
function NftPanel({ entry, held, albumKey, comments, viewer, onChanged, onClose }) {
  const { colors } = useTheme();
  const { width, height } = useWindowDimensions();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showDisputed, setShowDisputed] = useState(false);
  const [editing, setEditing] = useState(null); // { id, text } - my comment being changed
  const { item, traits } = entry;
  const [typing, setTyping] = useState(false);
  const keyboard = useKeyboardHeight(typing);
  // (typing: the comments scroll down to the field, above the keyboard)
  const onFieldFocus = () => {
    setTyping(true);
    setTimeout(() => panelScroll.current?.scrollToEnd?.({ animated: true }), 250);
  };
  const onFieldBlur = () => setTyping(false);
  const panelScroll = useRef(null);
  useKeepFocusedInputVisible(panelScroll);

  async function act(fn) {
    setBusy(true);
    setError('');
    try {
      await fn(await getMessenger());
      await onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const shown = comments.filter((c) => !c.disputed || showDisputed);
  const disputedCount = comments.filter((c) => c.disputed).length;
  // The NFT as Browse shows it (NftCard, album mode: no ID, no Kleverscan,
  // stats on a tap): this Hub's stored row, or one made from Moonlabs' data.
  const cardRow = entry.row || {
    nonce: item.nonce,
    name: entry.metadata?.name || null,
    image: entry.metadata?.image || albumPictureUrl(item),
    status: entry.metadata === false ? 'unavailable' : 'ok',
    ...traits,
  };
  // The NFT stays at the top; the comments scroll below it (Raphael, 28 Oct 2026).
  // With the keyboard open (phone), the NFT part gets smaller.
  const panelHeight = Math.min(height * 0.92, keyboard ? Math.max(260, height - keyboard - 48) : height * 0.92);
  const vote = (c, v) => act((m) => m.voteOnComment(c.id, viewer.votes[c.id] === v ? 0 : v));

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.backdrop, keyboard ? { paddingBottom: keyboard + 12, justifyContent: 'flex-end' } : null]}>
        <View
          style={[styles.panel, { backgroundColor: colors.background, borderColor: colors.border, width: Math.min(width - 24, 640), height: panelHeight }]}
          testID="album-panel"
        >
          <View style={[styles.pickRow, { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6 }]}>
            <Text style={[styles.small, { color: colors.secondaryText, flex: 1 }]}>{COLLECTIONS[item.kind].label} in this album</Text>
            <TouchableOpacity onPress={onClose} accessibilityLabel="Close" testID="album-panel-close">
              <Text style={{ color: colors.primary, fontSize: 20, fontWeight: '700' }}>✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={{ maxHeight: keyboard ? panelHeight * 0.3 : panelHeight * 0.55, flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 8 }} testID="album-panel-nft">
            <NftCard
              kind={item.kind}
              nft={cardRow}
              album={{
                title: nftTitle(entry),
                extra: (
                  <>
                    <Text style={[styles.note, { color: held === false ? colors.text : colors.secondaryText }]}>{heldText(held)}</Text>
                    {item.note ? <Text style={[styles.note, { color: colors.text, fontStyle: 'italic' }]}>Owner's note: {item.note}</Text> : null}
                  </>
                ),
              }}
            />
          </ScrollView>
          <View style={[styles.panelDivider, { backgroundColor: colors.border }]} />
          <ScrollView ref={panelScroll} style={{ flex: 1 }} contentContainerStyle={{ gap: 10, padding: 14 }} keyboardShouldPersistTaps="handled" testID="album-panel-comments">
            <Text style={[styles.section, { color: colors.text, marginHorizontal: 0 }]}>Comments</Text>
            <Text style={[styles.small, { color: colors.secondaryText }]}>
              Comments belong to this NFT, so they stay when it changes hands. Holders confirm what they know.
            </Text>
            {shown.map((c) => (
              <View key={c.id} testID="album-comment" style={[styles.comment, { borderColor: colors.border }, c.hidden && { opacity: 0.5 }]}>
                {editing?.id === c.id ? (
                  <>
                    <TextInput
                      style={[styles.input, { color: colors.text, borderColor: colors.primary, backgroundColor: colors.surface }]}
                      value={editing.text}
                      maxLength={200}
                      onChangeText={(t) => setEditing({ id: c.id, text: t })}
                      onFocus={() => setTyping(true)}
                      onBlur={onFieldBlur}
                      testID="album-comment-edit-input"
                    />
                    <Text style={[styles.small, { color: colors.secondaryText }]}>Saving starts the confirmations again (they were for the old text).</Text>
                  </>
                ) : (
                  <Text style={[styles.text, { color: colors.text }]}>{c.text}</Text>
                )}
                <Text style={[styles.small, { color: colors.secondaryText }]}>
                  {c.nickname} · {dateText(c.at)}{c.edited ? ` · edited ${dateText(c.edited)}` : ''}{c.hidden ? ' · hidden in your album' : ''}{c.disputed ? ' · disputed' : ''}
                </Text>
                <View style={styles.chipRow}>
                  {viewer.ready && c.nickname !== viewer.nickname ? (
                    <>
                      <TouchableOpacity disabled={busy} onPress={() => vote(c, 1)} testID="album-comment-confirm"
                        style={[styles.chip, { borderColor: viewer.votes[c.id] === 1 ? colors.primary : colors.border }]}>
                        <Text style={{ color: viewer.votes[c.id] === 1 ? colors.primary : colors.text, fontSize: 13 }}>✓ I can confirm ({c.confirms})</Text>
                      </TouchableOpacity>
                      <TouchableOpacity disabled={busy} onPress={() => vote(c, -1)} testID="album-comment-dispute"
                        style={[styles.chip, { borderColor: viewer.votes[c.id] === -1 ? colors.primary : colors.border }]}>
                        <Text style={{ color: viewer.votes[c.id] === -1 ? colors.primary : colors.text, fontSize: 13 }}>✗ not right ({c.disputes})</Text>
                      </TouchableOpacity>
                    </>
                  ) : (
                    <Text style={[styles.small, { color: colors.secondaryText }]} testID="album-comment-votes">✓ {c.confirms} · ✗ {c.disputes}</Text>
                  )}
                  {viewer.ready && c.nickname === viewer.nickname && editing?.id === c.id ? (
                    <>
                      <TouchableOpacity
                        disabled={busy || !editing.text.trim()}
                        onPress={() => act(async (m) => { await m.editComment(c.id, editing.text); setEditing(null); })}
                        style={[styles.chip, { borderColor: colors.primary }]}
                        testID="album-comment-save"
                      >
                        <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '700' }}>Save</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => setEditing(null)} style={[styles.chip, { borderColor: colors.border }]}>
                        <Text style={{ color: colors.text, fontSize: 13 }}>Cancel</Text>
                      </TouchableOpacity>
                    </>
                  ) : viewer.ready && c.nickname === viewer.nickname ? (
                    <>
                      <TouchableOpacity disabled={busy} onPress={() => setEditing({ id: c.id, text: c.text })} style={[styles.chip, { borderColor: colors.border }]} testID="album-comment-edit">
                        <Text style={{ color: colors.text, fontSize: 13 }}>Edit</Text>
                      </TouchableOpacity>
                      <TouchableOpacity disabled={busy} onPress={() => act((m) => m.deleteComment(c.id))} style={[styles.chip, { borderColor: colors.border }]} testID="album-comment-delete">
                        <Text style={{ color: colors.text, fontSize: 13 }}>Delete</Text>
                      </TouchableOpacity>
                    </>
                  ) : null}
                  {viewer.mine ? (
                    <TouchableOpacity disabled={busy} onPress={() => act((m) => m.hideCommentInAlbum(albumKey, c.id, !c.hidden))} style={[styles.chip, { borderColor: colors.border }]} testID="album-comment-hide">
                      <Text style={{ color: colors.text, fontSize: 13 }}>{c.hidden ? 'Show in my album' : 'Hide in my album'}</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              </View>
            ))}
            {!comments.length ? <Text style={[styles.small, { color: colors.secondaryText }]}>No comments yet.</Text> : null}
            {disputedCount && !showDisputed ? (
              <TouchableOpacity onPress={() => setShowDisputed(true)} testID="album-comments-disputed">
                <Text style={[styles.small, { color: colors.primary }]}>Show {disputedCount} disputed comment{disputedCount === 1 ? '' : 's'}</Text>
              </TouchableOpacity>
            ) : null}
            {viewer.ready && comments.filter((c) => c.nickname === viewer.nickname).length >= 2 ? (
              <Text style={[styles.small, { color: colors.secondaryText }]} testID="album-comment-max">
                You have two comments on this NFT (the most per player): edit or delete one to write another.
              </Text>
            ) : viewer.ready ? (
              <>
                <TextInput
                  style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                  placeholder="What do you know about it? e.g. From the May 2025 event"
                  placeholderTextColor={colors.secondaryText}
                  value={draft}
                  maxLength={200}
                  onChangeText={setDraft}
                  onFocus={onFieldFocus}
                  onBlur={onFieldBlur}
                  testID="album-comment-input"
                />
                <TouchableOpacity
                  disabled={busy || !draft.trim()}
                  onPress={() => act(async (m) => { await m.commentOnNft(albumKey, item.kind, item.nonce, draft); setDraft(''); })}
                  style={[styles.button, { backgroundColor: colors.primary, alignSelf: 'flex-start' }, (busy || !draft.trim()) && { opacity: 0.5 }]}
                  testID="album-comment-send"
                >
                  <Text style={[styles.buttonText, { color: colors.primaryText }]}>Comment as {viewer.nickname}</Text>
                </TouchableOpacity>
              </>
            ) : (
              <Text style={[styles.small, { color: colors.secondaryText }]}>To comment or confirm, sign in to the chat (holders only).</Text>
            )}
            {error ? <Text style={[styles.note, { color: colors.text }]} testID="album-comment-error">{error}</Text> : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/**
 * A conversation of the album mailbox: as a visitor with the album's
 * (anonymous) owner, or as the owner with one visitor (who can be blocked).
 */
function AlbumTalk({ talk, onThread }) {
  const { colors } = useTheme();
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState(false);
  const talkScroll = useRef(null);
  useKeepFocusedInputVisible(talkScroll);

  const load = useCallback(async () => {
    const m = await getMessenger();
    await m.collectAlbumTalk().catch(() => {});
    if (!talk.thread) return;
    setMessages(await m.albumMessages(talk.album, talk.side, talk.thread));
    const t = (await m.albumConversations()).find((x) => x.album === talk.album && x.side === talk.side && x.thread === talk.thread);
    setBlocked(!!t?.blocked);
  }, [talk.album, talk.side, talk.thread]);
  useEffect(() => {
    load().catch((e) => setError(e.message));
    const timer = setInterval(() => load().catch(() => {}), MAIL_CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [load]);

  async function send() {
    setBusy(true);
    setError('');
    try {
      const m = await getMessenger();
      if (talk.side === 'owner') await m.replyAsAlbum(talk.album, talk.thread, draft);
      else {
        const thread = await m.messageAlbumOwner(talk.album, talk.title, draft);
        if (thread !== talk.thread) onThread(thread);
      }
      setDraft('');
      if (talk.thread) await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleBlock() {
    try {
      await (await getMessenger()).blockAlbumVisitor(talk.album, talk.thread, !blocked);
      setBlocked(!blocked);
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <ScrollView ref={talkScroll} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.note, { color: colors.secondaryText }]}>
          {talk.side === 'owner'
            ? `${talk.nickname || 'This player'} wrote about your album. You answer under the album's name: they don't learn who you are.`
            : "The album's owner stays anonymous; they see your chat nickname. Messages are sealed like the chat."}
        </Text>
        {talk.side === 'owner' ? (
          <TouchableOpacity onPress={toggleBlock} style={[styles.smallButton, { borderColor: colors.border, alignSelf: 'flex-start' }]} testID="album-talk-block">
            <Text style={{ color: colors.text }}>{blocked ? 'Allow messages again' : 'Block (no more messages for this album)'}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {messages.map((msg) => (
        <View
          key={msg.id}
          testID="album-talk-message"
          style={[styles.bubble, msg.mine
            ? { alignSelf: 'flex-end', backgroundColor: colors.chipBackground, borderColor: colors.primary }
            : { alignSelf: 'flex-start', backgroundColor: colors.surface, borderColor: colors.border }]}
        >
          <Text style={[styles.text, { color: colors.text }]}>{msg.text}</Text>
          <Text style={[styles.small, { color: colors.secondaryText }]}>{new Date(msg.sentAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</Text>
        </View>
      ))}
      <View style={[styles.pad, { gap: 8 }]}>
        <TextInput
          style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface, minHeight: 60, textAlignVertical: 'top' }]}
          placeholder={talk.side === 'owner' ? 'Your answer' : 'Your message to the owner'}
          placeholderTextColor={colors.secondaryText}
          value={draft}
          multiline
          maxLength={2000}
          onChangeText={setDraft}
          testID="album-talk-draft"
        />
        <TouchableOpacity
          disabled={busy || !draft.trim()}
          onPress={send}
          style={[styles.button, { backgroundColor: colors.primary, alignSelf: 'flex-start' }, (busy || !draft.trim()) && { opacity: 0.5 }]}
          testID="album-talk-send"
        >
          {busy ? <ActivityIndicator color={colors.primaryText} /> : <Text style={[styles.buttonText, { color: colors.primaryText }]}>Send</Text>}
        </TouchableOpacity>
        {error ? <Text style={[styles.note, { color: colors.text }]} testID="album-talk-error">{error}</Text> : null}
      </View>
    </ScrollView>
  );
}

// --- my albums -----------------------------------------------------------------------

function MyAlbums({ onOpen, onEdit, onTalk }) {
  const { colors } = useTheme();
  const [state, setState] = useState(null); // messenger status
  const [mine, setMine] = useState([]);
  const [talks, setTalks] = useState([]); // album conversations (both sides)
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let stopped = false;
    (async () => {
      try {
        const m = await getMessenger();
        const [s, list] = await Promise.all([m.status(), m.myAlbums()]);
        if (!stopped) { setState(s); setMine(list); }
        if (s.state === 'ready') await m.collectAlbumTalk().catch(() => {});
        const t = await m.albumConversations();
        if (!stopped) setTalks(t);
      } catch (e) {
        if (!stopped) setError(e.message);
      }
    })();
    return () => { stopped = true; };
  }, [tick]);

  function remove(a) {
    Alert.alert(`Delete "${a.album?.title || 'this album'}"?`, 'It disappears for everyone. Your NFTs stay where they are.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await (await getMessenger()).deleteAlbum(a.key);
            setTick((t) => t + 1);
          } catch (e) {
            setError(e.message);
          }
        },
      },
    ]);
  }

  if (!state && !error) return <ActivityIndicator style={styles.pad} color={colors.primary} />;
  const ready = state?.state === 'ready';
  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      {error ? <Text style={[styles.note, styles.pad, { color: colors.text }]}>{error}</Text> : null}
      {talks.length ? (
        <>
          <Text style={[styles.section, { color: colors.text }]}>Messages</Text>
          {talks.map((t) => (
            <TouchableOpacity
              key={`${t.album}/${t.side}/${t.thread}`}
              testID="album-talk-row"
              style={[styles.card, { backgroundColor: colors.surface, borderColor: t.unread ? colors.primary : colors.border }]}
              onPress={() => onTalk(t)}
            >
              <Text style={[styles.text, { color: colors.text, fontWeight: t.unread ? '700' : '400' }]} numberOfLines={1}>
                {t.side === 'owner' ? `${t.nickname || 'A player'} about "${t.title || 'your album'}"` : `To the owner of "${t.title || 'an album'}"`}
                {t.unread ? ` · ${t.unread} new` : ''}
              </Text>
              {t.blocked ? <Text style={[styles.small, { color: colors.secondaryText }]}>Blocked</Text> : null}
            </TouchableOpacity>
          ))}
          <Text style={[styles.section, { color: colors.text }]}>Albums</Text>
        </>
      ) : null}
      {!ready ? (
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.text, { color: colors.text }]}>
            To make an album, sign in to the chat first (it checks that you hold Devikins, and keeps albums free of spam).
            Your albums still aren't linked to your chat nickname unless you choose so.
          </Text>
          <TouchableOpacity
            style={[styles.button, { backgroundColor: colors.primary, alignSelf: 'flex-start' }]}
            onPress={() => { if (!openChatDock()) openChatScreen(); }}
          >
            <Text style={[styles.buttonText, { color: colors.primaryText }]}>Open the chat</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity style={[styles.button, styles.pad, { backgroundColor: colors.primary, alignSelf: 'flex-start' }]} onPress={() => onEdit(null)} testID="album-new">
          <Text style={[styles.buttonText, { color: colors.primaryText }]}>New album</Text>
        </TouchableOpacity>
      )}
      {mine.map((a) => (
        <View key={a.key} testID="my-album" style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.albumTitle, { color: colors.text }]} numberOfLines={1}>{a.album?.title || 'Not published yet'}</Text>
          <Text style={[styles.note, { color: colors.secondaryText }]}>
            {a.album ? `${a.album.items.length} NFTs · ${a.album.name ? `shows ${a.album.name}` : 'anonymous'} · ${shortAddress(a.album.wallet)}` : 'Started, but not published.'}
          </Text>
          <View style={styles.buttonRow}>
            {a.album ? (
              <TouchableOpacity style={[styles.smallButton, { borderColor: colors.border }]} onPress={() => onOpen(a.key)}>
                <Text style={{ color: colors.text }}>View</Text>
              </TouchableOpacity>
            ) : null}
            {ready ? (
              <TouchableOpacity style={[styles.smallButton, { borderColor: colors.border }]} onPress={() => onEdit(a.key)} testID="my-album-edit">
                <Text style={{ color: colors.text }}>Edit</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={[styles.smallButton, { borderColor: colors.border }]} onPress={() => remove(a)} testID="my-album-delete">
              <Text style={{ color: colors.text }}>Delete</Text>
            </TouchableOpacity>
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

// --- making / changing an album ---------------------------------------------------------

const PICK_PAGE = 60;

/**
 * New album: 1) the privacy note, 2) the wallet signs (that wallet becomes
 * the album's wallet - it must be one of the Hub's wallets, fetched, so its
 * NFTs can be picked), 3) title, NFTs with a note and a section each,
 * publish. Existing album: the same wallet and proof; everything else can change.
 */
function AlbumEditor({ albumKey, onDone }) {
  const { colors } = useTheme();
  const [key, setKey] = useState(albumKey);
  const [wallet, setWallet] = useState(null);
  const [proof, setProof] = useState(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [showName, setShowName] = useState(false);
  const [nickname, setNickname] = useState(null);
  // `${kind}/${nonce}` -> { kind, nonce, note, section, pic }
  const [picked, setPicked] = useState({});
  const [order, setOrder] = useState([]);
  const [owned, setOwned] = useState(null); // the wallet's NFTs from the Hub's own database
  const [pickKind, setPickKind] = useState('devikin');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(PICK_PAGE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [published, setPublished] = useState(false);
  const started = useRef(false);
  const editorScroll = useRef(null);
  useKeepFocusedInputVisible(editorScroll);

  // An existing album: what it shows now.
  useEffect(() => {
    (async () => {
      const m = await getMessenger();
      setNickname((await m.status()).nickname);
      if (!albumKey) return;
      const a = (await m.myAlbums()).find((x) => x.key === albumKey)?.album;
      if (!a) return;
      setWallet(a.wallet);
      setProof(a.proof);
      setTitle(a.title);
      setDescription(a.description);
      setShowName(!!a.name);
      setPicked(Object.fromEntries(a.items.map((i) => [`${i.kind}/${i.nonce}`, { ...i, note: i.note || '', section: i.section || '' }])));
      setOrder(a.items.map((i) => `${i.kind}/${i.nonce}`));
    })().catch((e) => setError(e.message));
  }, [albumKey]);

  // The wallet's NFTs, as far as the Hub has loaded them.
  useEffect(() => {
    if (!wallet) return;
    (async () => {
      const rows = [];
      for (const kind of KINDS) {
        for (const r of await queryNfts(kind, [wallet], {}, true)) {
          rows.push({ kind, nonce: r.nonce, name: gameNameOf(r) || r.custom_name || null, rarity: r.rarity || null, nft: r });
        }
      }
      setOwned(rows);
      // (start on a kind the wallet actually has)
      const first = KINDS.find((k) => rows.some((r) => r.kind === k));
      if (first) setPickKind(first);
    })().catch((e) => setError(e.message));
  }, [wallet]);

  /** Steps 1 + 2: the privacy note, then the wallet's signature. */
  function startNew() {
    Alert.alert(
      'Albums are public',
      'Everyone can see your album - also people without the Hub. The Hub doesn\'t show your wallet address or the NFTs\' numbers, '
        + 'but they are in the album\'s data, so someone determined can find the wallet and look it up on Kleverscan '
        + '(everything in it, and its transfers).\n\n'
        + 'Your chat nickname is NOT shown, unless you switch it on.\n\n'
        + 'Tip: a separate "showcase" wallet keeps your main wallet private.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'I understand, continue', onPress: () => signWallet() },
      ],
    );
  }

  async function signWallet() {
    if (started.current) return;
    started.current = true;
    setBusy(true);
    setError('');
    const m = await getMessenger();
    let made = null;
    try {
      made = await m.newAlbum();
      const { address, signature } = await signChatText(made.proofText);
      const hubWallets = (await getWallets()).map((w) => w.address);
      if (!hubWallets.includes(address)) {
        throw new Error(`The wallet that signed (${shortAddress(address)}) isn't in the Hub's wallets (in the wallet set you're using). Add it under Wallets and load its NFTs (Fetch/Update), then start the album again.`);
      }
      setKey(made.key);
      setWallet(address);
      setProof(signature);
    } catch (e) {
      if (made) await m.deleteAlbum(made.key).catch(() => {});
      setError(e.message);
    } finally {
      started.current = false;
      setBusy(false);
    }
  }

  function toggle(row) {
    const id = `${row.kind}/${row.nonce}`;
    if (picked[id]) {
      const { [id]: _gone, ...rest } = picked;
      setPicked(rest);
      setOrder((o) => o.filter((x) => x !== id));
    } else if (order.length < MAX_ALBUM_ITEMS) {
      setPicked({ ...picked, [id]: { kind: row.kind, nonce: row.nonce, note: '', section: '' } });
      setOrder((o) => [...o, id]);
    }
  }
  const setField = (id, field, value) => setPicked((old) => ({ ...old, [id]: { ...old[id], [field]: value } }));

  async function publish() {
    setBusy(true);
    setError('');
    try {
      const m = await getMessenger();
      await m.publishAlbum(key, {
        title, description, showName, wallet, proof,
        items: order.map((id) => {
          const p = picked[id];
          // The picture's folder as this Hub has it (visitors load the picture straight from there).
          const stored = ownedById[id]?.nft?.image;
          const pic = stored ? pictureFolderOf(p.kind, p.nonce, stored) : p.pic;
          return { kind: p.kind, nonce: p.nonce, note: p.note, section: p.section, pic: Number.isInteger(pic) ? pic : undefined };
        }),
      });
      setPublished(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const ownedById = useMemo(() => Object.fromEntries((owned || []).map((r) => [`${r.kind}/${r.nonce}`, r])), [owned]);
  const ofKind = useMemo(() => {
    if (!owned) return [];
    const q = search.trim().toLowerCase();
    return owned
      .filter((r) => r.kind === pickKind && !picked[`${r.kind}/${r.nonce}`])
      .filter((r) => !q || String(r.nonce).includes(q) || (r.name || '').toLowerCase().includes(q) || (r.rarity || '').toLowerCase().includes(q));
  }, [owned, search, picked, pickKind]);
  useEffect(() => setLimit(PICK_PAGE), [pickKind, search]);
  const sectionNames = [...new Set(order.map((id) => (picked[id]?.section || '').trim()).filter(Boolean))];

  if (published) {
    return (
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.text, { color: colors.text }]} testID="album-published">Published. Everyone can see it under Collectors Albums now.</Text>
        <TouchableOpacity style={[styles.button, { backgroundColor: colors.primary, alignSelf: 'flex-start' }]} onPress={onDone}>
          <Text style={[styles.buttonText, { color: colors.primaryText }]}>Done</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!wallet) {
    return (
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.text, { color: colors.text }]}>
            First, the wallet whose NFTs you'd like to show signs a short text with the {CHAT_WALLET}. It isn't a
            transaction: it costs nothing and moves nothing. It shows visitors that the album is really yours.
          </Text>
          <TouchableOpacity
            style={[styles.button, { backgroundColor: colors.primary, alignSelf: 'flex-start' }, busy && { opacity: 0.5 }]}
            disabled={busy}
            onPress={startNew}
            testID="album-sign"
          >
            {busy ? <ActivityIndicator color={colors.primaryText} /> : <Text style={[styles.buttonText, { color: colors.primaryText }]}>Sign with the wallet</Text>}
          </TouchableOpacity>
          {error ? <Text style={[styles.note, { color: colors.text }]} testID="album-error">{error}</Text> : null}
        </View>
      </ScrollView>
    );
  }

  const input = [styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }];
  const chip = (label, active, onPress, testID) => (
    <TouchableOpacity
      key={label}
      testID={testID}
      onPress={onPress}
      style={[styles.chip, { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.chipBackground : 'transparent' }]}
    >
      <Text style={{ color: active ? colors.primary : colors.text, fontSize: 13, fontWeight: active ? '700' : '500' }}>{label}</Text>
    </TouchableOpacity>
  );
  return (
    <ScrollView ref={editorScroll} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.note, { color: colors.secondaryText }]}>Wallet: {shortAddress(wallet)} (signed; visitors don't see it on the screen)</Text>
        <TextInput style={input} placeholder="Title" placeholderTextColor={colors.secondaryText} value={title} maxLength={MAX_ALBUM_TITLE} onChangeText={setTitle} testID="album-title-input" />
        <TextInput
          style={[...input, { minHeight: 70, textAlignVertical: 'top' }]}
          placeholder="A few words about the collection (optional)"
          placeholderTextColor={colors.secondaryText}
          value={description}
          maxLength={MAX_ALBUM_DESCRIPTION}
          multiline
          onChangeText={setDescription}
        />
        <View style={styles.switchRow}>
          <Switch value={showName} onValueChange={setShowName} disabled={!nickname} testID="album-show-name" />
          <Text style={[styles.note, { color: colors.text, flex: 1 }]}>
            {nickname ? `Show my chat nickname (${nickname}) on it. Off: the album stays anonymous.` : 'Anonymous (pick a chat nickname to be able to show it).'}
          </Text>
        </View>
      </View>

      <Text style={[styles.section, { color: colors.text }]}>In the album ({order.length}/{MAX_ALBUM_ITEMS})</Text>
      {order.length ? (
        <Text style={[styles.note, styles.pad, { color: colors.secondaryText }]}>
          Sections group your NFTs under headings, e.g. "May event 2025" or "Eldritch". NFTs without a section come first.
        </Text>
      ) : null}
      {order.map((id) => {
        const p = picked[id];
        const row = ownedById[id];
        return (
          <View key={id} testID="album-picked" style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={styles.pickRow}>
              {row ? <PickThumb nft={row.nft} /> : null}
              <Text style={[styles.text, { color: colors.text, flex: 1 }]} numberOfLines={1}>
                {row?.name ? `${row.name} ` : ''}#{p.nonce} · {COLLECTIONS[p.kind].label}
                {owned && !row ? ' (not in the Hub for this wallet)' : ''}
              </Text>
              <TouchableOpacity onPress={() => toggle(p)} accessibilityLabel="Take out">
                <Text style={{ color: colors.primary, fontWeight: '700' }}>✕</Text>
              </TouchableOpacity>
            </View>
            <TextInput
              style={input}
              placeholder="Note (optional), e.g. Bonded Yoda"
              placeholderTextColor={colors.secondaryText}
              value={p.note}
              maxLength={MAX_ALBUM_NOTE}
              onChangeText={(t) => setField(id, 'note', t)}
            />
            <TextInput
              style={input}
              placeholder="Section (optional), e.g. May event 2025"
              placeholderTextColor={colors.secondaryText}
              value={p.section}
              maxLength={MAX_ALBUM_SECTION}
              onChangeText={(t) => setField(id, 'section', t)}
              testID="album-section-input"
            />
            {sectionNames.filter((s) => s !== (p.section || '').trim()).length ? (
              <View style={styles.chipRow}>
                {sectionNames.filter((s) => s !== (p.section || '').trim()).map((s) => chip(s, false, () => setField(id, 'section', s), 'album-section-chip'))}
              </View>
            ) : null}
          </View>
        );
      })}

      <Text style={[styles.section, { color: colors.text }]}>Add from this wallet</Text>
      <View style={[styles.chipRow, styles.pad]}>
        {KINDS.map((k) => chip(
          `${COLLECTIONS[k].label} (${(owned || []).filter((r) => r.kind === k).length})`,
          pickKind === k,
          () => setPickKind(k),
          `album-pick-kind-${k}`,
        ))}
      </View>
      <TextInput style={[...input, styles.pad]} placeholder="Search by name, rarity or ID" placeholderTextColor={colors.secondaryText} value={search} onChangeText={setSearch} testID="album-search" />
      {owned && ofKind.length === 0 ? (
        <Text style={[styles.note, styles.pad, { color: colors.secondaryText }]}>
          {owned.some((r) => r.kind === pickKind)
            ? 'Nothing more to add here.'
            : `The Hub has no ${COLLECTIONS[pickKind].label} loaded for this wallet. If it holds some, load them under Wallets (Fetch/Update).`}
        </Text>
      ) : null}
      {ofKind.slice(0, limit).map((r) => (
        <TouchableOpacity
          key={`${r.kind}/${r.nonce}`}
          testID="album-pick"
          style={[styles.pickRow, styles.pickLine, { borderColor: colors.border }]}
          onPress={() => toggle(r)}
        >
          <PickThumb nft={r.nft} />
          <Text style={[styles.text, { color: colors.text, flex: 1 }]} numberOfLines={1}>
            {r.name ? `${r.name} ` : ''}#{r.nonce}{r.rarity ? ` · ${r.rarity}` : ''}
          </Text>
          <Text style={{ color: colors.primary, fontWeight: '700' }}>＋</Text>
        </TouchableOpacity>
      ))}
      {ofKind.length > limit ? (
        <TouchableOpacity style={[styles.smallButton, styles.pad, { borderColor: colors.border, alignSelf: 'flex-start' }]} onPress={() => setLimit((l) => l + PICK_PAGE)} testID="album-pick-more">
          <Text style={{ color: colors.text }}>Show more ({ofKind.length - limit} left)</Text>
        </TouchableOpacity>
      ) : null}

      {error ? <Text style={[styles.note, styles.pad, { color: colors.text }]} testID="album-error">{error}</Text> : null}
      <TouchableOpacity
        style={[styles.button, styles.pad, { backgroundColor: colors.primary, alignSelf: 'flex-start' }, (busy || !title.trim() || !order.length) && { opacity: 0.5 }]}
        disabled={busy || !title.trim() || !order.length}
        onPress={publish}
        testID="album-publish"
      >
        {busy ? <ActivityIndicator color={colors.primaryText} /> : <Text style={[styles.buttonText, { color: colors.primaryText }]}>Publish</Text>}
      </TouchableOpacity>
    </ScrollView>
  );
}

function PickThumb({ nft }) {
  const { colors } = useTheme();
  const { imageSource, imageLoadFailed, onImageError } = useNftImage(nft);
  return imageSource && !imageLoadFailed ? (
    <Image source={{ uri: imageSource }} style={styles.thumb} resizeMode="contain" onError={onImageError} />
  ) : (
    <View style={[styles.thumb, { backgroundColor: colors.placeholderBackground }]} />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topRow: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 12, marginVertical: 12, gap: 8 },
  backButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  backButtonText: { fontSize: 22, fontWeight: '700', lineHeight: 24 },
  title: { flex: 1, fontSize: 18, fontWeight: '700' },
  scroll: { paddingBottom: 40, maxWidth: 1100, width: '100%', alignSelf: 'center' },
  card: { marginHorizontal: 12, marginBottom: 10, padding: 14, borderRadius: 12, borderWidth: 1, gap: 10 },
  pad: { marginHorizontal: 12, marginBottom: 10 },
  text: { fontSize: 15, lineHeight: 21 },
  note: { fontSize: 13, lineHeight: 18 },
  small: { fontSize: 12, lineHeight: 16 },
  section: { fontSize: 15, fontWeight: '700', marginHorizontal: 12, marginTop: 8, marginBottom: 8 },
  albumTitle: { fontSize: 17, fontWeight: '700' },
  button: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8 },
  buttonText: { fontSize: 15, fontWeight: '700' },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  smallButton: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginHorizontal: 12 },
  item: { borderWidth: 1, borderRadius: 10, padding: 8, gap: 4 },
  itemImage: { width: '100%', aspectRatio: 1, borderRadius: 6 },
  itemName: { fontSize: 14, fontWeight: '700' },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9, fontSize: 15 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pickLine: { marginHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1 },
  thumb: { width: 40, height: 40, borderRadius: 6 },
  chip: { paddingVertical: 5, paddingHorizontal: 10, borderRadius: 14, borderWidth: 1 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: 12 },
  panel: { maxHeight: '92%', borderWidth: 1, borderRadius: 14, overflow: 'hidden' },
  panelDivider: { height: StyleSheet.hairlineWidth * 2 },
  comment: { borderWidth: 1, borderRadius: 10, padding: 10, gap: 6 },
  bubble: { marginHorizontal: 12, marginBottom: 8, padding: 10, borderRadius: 12, borderWidth: 1, maxWidth: '80%', gap: 4 },
  filterBox: { marginHorizontal: 12, marginBottom: 10, paddingBottom: 10, gap: 8, borderBottomWidth: 1 },
});
