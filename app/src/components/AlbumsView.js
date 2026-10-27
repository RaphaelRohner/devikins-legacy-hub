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
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Image, Switch, Alert, Platform, useWindowDimensions,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import useNftImage from '../hooks/useNftImage';
import { COLLECTIONS, kleverscanNftUrl, gameNameOf } from '../constants/schema';
import { POSTMAN_URL } from '../constants/chat';
import { publicAlbums } from '../../chat/src/client.js';
import { MAX_ALBUM_ITEMS, MAX_ALBUM_TITLE, MAX_ALBUM_DESCRIPTION, MAX_ALBUM_NOTE } from '../../chat/src/album.js';
import { fetchNftMetadata } from '../api/metadataApi';
import { holdsNft } from '../api/withdrawalTracker';
import { getMessenger } from '../api/chatStore';
import { signChatText, CHAT_WALLET } from '../api/chatWallet';
import { getWallets, queryNfts } from '../db/database';
import { openKleverscan } from '../api/openKleverscan';
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
  // 'list' | 'album' | 'mine' | 'edit'
  const [view, setView] = useState('list');
  const [openKey, setOpenKey] = useState(null);
  const [editKey, setEditKey] = useState(null);
  const [backTo, setBackTo] = useState('list');

  const header = (title, onBack) => (
    <View style={styles.topRow}>
      <TouchableOpacity style={[styles.backButton, { backgroundColor: colors.primary }]} onPress={onBack} accessibilityLabel="Back">
        <Text style={[styles.backButtonText, { color: colors.primaryText }]}>‹</Text>
      </TouchableOpacity>
      <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{title}</Text>
    </View>
  );

  if (view === 'album') {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        {header('Collectors Album', () => setView(backTo))}
        <AlbumDetail albumKey={openKey} />
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
          <Text style={[styles.buttonText, { color: colors.primaryText }]}>My albums</Text>
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

/**
 * One album, checked: its signature and the wallet's proof (publicAlbums.one),
 * then per NFT its picture and name (Moonlabs' metadata, like the rest of the
 * Hub) and whether the wallet still holds it (Klever's node).
 */
function AlbumDetail({ albumKey, preview = null }) {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const [album, setAlbum] = useState(preview);
  const [error, setError] = useState('');
  // `${kind}/${nonce}` -> { metadata, held: true | false | null (couldn't check) }
  const [info, setInfo] = useState({});

  useEffect(() => {
    let stopped = false;
    (async () => {
      try {
        const a = preview || (await reader().one(albumKey));
        if (stopped) return;
        setAlbum(a);
        const jobs = a.items.map((i) => async () => {
          const id = `${i.kind}/${i.nonce}`;
          const [meta, held] = await Promise.all([
            fetchNftMetadata(i.kind, i.nonce, () => stopped),
            holdsNft(a.wallet, i.kind, i.nonce).catch(() => null),
          ]);
          if (!stopped) setInfo((old) => ({ ...old, [id]: { metadata: meta.outcome === 'ok' ? meta.metadata : null, held } }));
        });
        await runLimited(jobs, 3, () => stopped);
      } catch (e) {
        if (!stopped) setError(e.message);
      }
    })();
    return () => { stopped = true; };
  }, [albumKey, preview]);

  if (error) return <Text style={[styles.note, styles.pad, { color: colors.text }]}>{error}</Text>;
  if (!album) return <ActivityIndicator style={styles.pad} color={colors.primary} />;
  const gone = album.items.filter((i) => info[`${i.kind}/${i.nonce}`]?.held === false).length;
  const columns = width >= 900 ? 4 : width >= 600 ? 3 : 2;
  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.albumTitle, { color: colors.text }]} testID="album-title">{album.title}</Text>
        <Text style={[styles.note, { color: colors.secondaryText }]}>
          {album.name ? `by ${album.name}` : 'Anonymous collector'} · updated {dateText(album.updatedAt)}
        </Text>
        {album.description ? <Text style={[styles.text, { color: colors.text }]}>{album.description}</Text> : null}
        <Text style={[styles.note, { color: colors.secondaryText }]}>
          Wallet (signed by its owner):{' '}
          <Text style={{ textDecorationLine: 'underline' }} onPress={() => openKleverscan(`https://kleverscan.org/account/${album.wallet}`)}>
            {shortAddress(album.wallet)}
          </Text>
        </Text>
        {gone ? (
          <Text style={[styles.note, { color: colors.text }]} testID="album-gone">
            {gone} of these NFTs {gone === 1 ? 'is' : 'are'} no longer in this wallet (shown faded).
          </Text>
        ) : null}
      </View>
      <View style={styles.grid}>
        {album.items.map((i) => (
          <AlbumItem key={`${i.kind}/${i.nonce}`} item={i} info={info[`${i.kind}/${i.nonce}`]} columns={columns} />
        ))}
      </View>
    </ScrollView>
  );
}

function AlbumItem({ item, info, columns }) {
  const { colors } = useTheme();
  const { imageSource, imageLoadFailed, onImageError } = useNftImage(info?.metadata ? { image: info.metadata.image } : null);
  const name = info?.metadata ? gameNameOf({ name: info.metadata.name, nonce: item.nonce }) : null;
  const held = info?.held;
  return (
    <View
      testID="album-item"
      style={[styles.item, { width: `${100 / columns - 2}%`, backgroundColor: colors.surface, borderColor: colors.border }, held === false && { opacity: 0.45 }]}
    >
      {imageSource && !imageLoadFailed ? (
        <Image source={{ uri: imageSource }} style={styles.itemImage} resizeMode="contain" onError={onImageError} />
      ) : (
        <View style={[styles.itemImage, { backgroundColor: colors.placeholderBackground, alignItems: 'center', justifyContent: 'center' }]}>
          {info ? <Text style={{ color: colors.placeholderText, fontSize: 12 }}>No picture</Text> : <ActivityIndicator color={colors.primary} />}
        </View>
      )}
      <Text style={[styles.itemName, { color: colors.text }]} numberOfLines={1}>
        {name ? `${name} ` : ''}#{item.nonce}
      </Text>
      <Text style={[styles.small, { color: colors.secondaryText }]}>
        {COLLECTIONS[item.kind].label}
        {held === true ? ' · ✓ in the wallet' : held === false ? ' · no longer in the wallet' : held === null ? " · couldn't check" : ''}
      </Text>
      {item.note ? <Text style={[styles.small, { color: colors.text, fontStyle: 'italic' }]}>{item.note}</Text> : null}
      <Text style={[styles.small, { color: colors.primary }]} onPress={() => openKleverscan(kleverscanNftUrl(item.kind, item.nonce))}>
        Kleverscan
      </Text>
    </View>
  );
}

// --- my albums -----------------------------------------------------------------------

function MyAlbums({ onOpen, onEdit }) {
  const { colors } = useTheme();
  const [state, setState] = useState(null); // messenger status
  const [mine, setMine] = useState([]);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let stopped = false;
    (async () => {
      try {
        const m = await getMessenger();
        const [s, list] = await Promise.all([m.status(), m.myAlbums()]);
        if (!stopped) { setState(s); setMine(list); }
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

/**
 * New album: 1) the privacy note, 2) the wallet signs (that wallet becomes
 * the album's wallet - it must be one of the Hub's wallets, fetched, so its
 * NFTs can be picked), 3) title, notes, NFTs, publish. Existing album: the
 * same wallet and proof; everything else can change.
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
  // `${kind}/${nonce}` -> { kind, nonce, note }
  const [picked, setPicked] = useState({});
  const [order, setOrder] = useState([]);
  const [owned, setOwned] = useState(null); // the wallet's NFTs from the Hub's own database
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [published, setPublished] = useState(false);
  const started = useRef(false);

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
      setPicked(Object.fromEntries(a.items.map((i) => [`${i.kind}/${i.nonce}`, { ...i, note: i.note || '' }])));
      setOrder(a.items.map((i) => `${i.kind}/${i.nonce}`));
    })().catch((e) => setError(e.message));
  }, [albumKey]);

  // The wallet's NFTs, as far as the Hub has loaded them.
  useEffect(() => {
    if (!wallet) return;
    (async () => {
      const rows = [];
      for (const kind of KINDS) {
        for (const r of await queryNfts(kind, [wallet], {}, true)) rows.push({ kind, nonce: r.nonce, name: gameNameOf(r) || r.custom_name || null, nft: r });
      }
      setOwned(rows);
    })().catch((e) => setError(e.message));
  }, [wallet]);

  /** Steps 1 + 2: the privacy note, then the wallet's signature. */
  function startNew() {
    Alert.alert(
      'Albums are public',
      'Everyone can see your album - also people without the Hub - including the wallet address it shows. '
        + 'Anyone can look that wallet up on Kleverscan (everything in it, and its transfers).\n\n'
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
      setPicked({ ...picked, [id]: { kind: row.kind, nonce: row.nonce, note: '' } });
      setOrder((o) => [...o, id]);
    }
  }

  async function publish() {
    setBusy(true);
    setError('');
    try {
      const m = await getMessenger();
      await m.publishAlbum(key, {
        title, description, showName, wallet, proof,
        items: order.map((id) => ({ kind: picked[id].kind, nonce: picked[id].nonce, note: picked[id].note })),
      });
      setPublished(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const matches = useMemo(() => {
    if (!owned) return [];
    const q = search.trim().toLowerCase();
    return owned
      .filter((r) => !picked[`${r.kind}/${r.nonce}`])
      .filter((r) => !q || String(r.nonce).includes(q) || (r.name || '').toLowerCase().includes(q))
      .slice(0, 60);
  }, [owned, search, picked]);
  const ownedById = useMemo(() => Object.fromEntries((owned || []).map((r) => [`${r.kind}/${r.nonce}`, r])), [owned]);

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
  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.note, { color: colors.secondaryText }]}>Wallet: {shortAddress(wallet)} (signed)</Text>
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
              placeholder="Note (optional), e.g. May event 2025"
              placeholderTextColor={colors.secondaryText}
              value={p.note}
              maxLength={MAX_ALBUM_NOTE}
              onChangeText={(t) => setPicked((old) => ({ ...old, [id]: { ...old[id], note: t } }))}
            />
          </View>
        );
      })}

      <Text style={[styles.section, { color: colors.text }]}>Add from this wallet</Text>
      <TextInput style={[...input, styles.pad]} placeholder="Search by name or ID" placeholderTextColor={colors.secondaryText} value={search} onChangeText={setSearch} testID="album-search" />
      {owned && owned.length === 0 ? (
        <Text style={[styles.note, styles.pad, { color: colors.secondaryText }]}>
          The Hub has no NFTs loaded for this wallet. Add it under Wallets and load them (Fetch/Update).
        </Text>
      ) : null}
      {matches.map((r) => (
        <TouchableOpacity
          key={`${r.kind}/${r.nonce}`}
          testID="album-pick"
          style={[styles.pickRow, styles.pickLine, { borderColor: colors.border }]}
          onPress={() => toggle(r)}
        >
          <PickThumb nft={r.nft} />
          <Text style={[styles.text, { color: colors.text, flex: 1 }]} numberOfLines={1}>
            {r.name ? `${r.name} ` : ''}#{r.nonce} · {COLLECTIONS[r.kind].label}
          </Text>
          <Text style={{ color: colors.primary, fontWeight: '700' }}>＋</Text>
        </TouchableOpacity>
      ))}

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
});
