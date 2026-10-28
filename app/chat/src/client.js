/**
 * client.js — talking to the blind postman (chat/postman)
 *
 * One small function per postman request. Every request except the
 * code-only drops is signed with this device's chat key (NIP-98, see
 * chat/src/httpAuth.js). Answers come back as plain objects; when the
 * postman refuses, this throws an Error with the postman's own plain
 * message (e.g. "Next contact request possible in 4 min.") and `.status`.
 */

import { makeAuthHeader } from './httpAuth.js';
import { checkAlbum } from './album.js';

export function createPostmanClient({ baseUrl, identity, fetchFn = (...a) => fetch(...a), now = () => Date.now() }) {
  const base = baseUrl.replace(/\/+$/, '');

  async function call(method, path, body, { signed = true } = {}) {
    const url = base + path;
    const bodyText = method === 'POST' ? JSON.stringify(body ?? {}) : '';
    const headers = {};
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    if (signed) headers.Authorization = makeAuthHeader(identity, { url, method, bodyText, now: now() });
    let response;
    try {
      response = await fetchFn(url, { method, headers, body: method === 'POST' ? bodyText : undefined });
    } catch {
      const e = new Error("Can't reach the chat postman. Check the internet connection and try again.");
      e.status = 0;
      throw e;
    }
    let answer = null;
    try { answer = await response.json(); } catch { answer = null; }
    if (!response.ok) {
      const e = new Error(answer?.error || `The chat postman answered ${response.status}.`);
      e.status = response.status;
      throw e;
    }
    return answer;
  }

  return {
    hello: () => call('GET', '/hello', null, { signed: false }),
    startSignIn: () => call('POST', '/signin/start'),
    finishSignIn: ({ code, wallet, signature }) => call('POST', '/signin/finish', { code, wallet, signature }),
    me: () => call('GET', '/me'),
    setNickname: (nickname) => call('POST', '/nickname', { nickname }),
    directory: (q = '') => call('GET', `/directory?q=${encodeURIComponent(q)}`),
    request: (nickname, items) => call('POST', '/request', { nickname, items }),
    codes: ({ add = [], remove = [] }) => call('POST', '/codes', { add, remove }),
    drop: (code, items) => call('POST', '/drop', { code, items }, { signed: false }),
    devicesFor: (code) => call('POST', '/drop/devices', { code }, { signed: false }),
    mail: () => call('GET', '/mail'),
    // Linked devices (27 Oct 2026): envelopes for this player's OWN other devices, and taking one out.
    self: (items) => call('POST', '/self', { items }),
    removeDevice: (key) => call('POST', '/me/devices/remove', { key }),
    // Linking a device by QR code (27 Oct 2026)
    linkStart: (badge) => call('POST', '/link/start', { badge }),
    linkFinish: (code) => call('POST', '/link/finish', { code }),
    badgesMine: (badge) => call('POST', '/badges/mine', { badge }),
    mailDone: (ids) => call('POST', '/mail/done', { ids }),
    leave: () => call('POST', '/leave', {}),
    groups: () => call('GET', '/groups'),
    createGroup: ({ id, name, description, keyCheck, badge }) => call('POST', '/groups/create', { id, name, description, keyCheck, badge }),
    myGroups: () => call('GET', '/groups/mine'),
    joinGroup: (group, code) => call('POST', '/groups/join', { group, code }),
    groupJoins: (group) => call('GET', `/groups/joins?group=${group}`),
    admit: (group, account) => call('POST', '/groups/admit', { group, account }),
    groupMembers: (group) => call('GET', `/groups/members?group=${group}`),
    leaveGroup: (group) => call('POST', '/groups/leave', { group }),
    setPinned: (group, envelope) => call('POST', '/groups/pin', { group, envelope }),
    pinned: (group) => call('GET', `/groups/pin?group=${group}`),
    // (reaction: a 👍 / 👎 - the postman doesn't hold it to the 10-second gap)
    groupPost: (envelope, { reaction = false } = {}) => call('POST', '/group/post', reaction ? { envelope, reaction: true } : { envelope }),
    votes: (group) => call('GET', `/groups/votes?group=${group}`),
    proofStart: () => call('POST', '/proof/start'),
    openVote: ({ group, accused, reason, proof }) => call('POST', '/groups/vote/open', { group, accused, reason, proof }),
    castVote: ({ vote, yes, proof }) => call('POST', '/groups/vote/cast', { vote, yes, proof }),
    unban: (group, ban) => call('POST', '/groups/unban', { group, ban }),
    rekey: ({ group, epoch, keyCheck, items }) => call('POST', '/groups/rekey', { group, epoch, keyCheck, items }),
    groupPosts: (group, after) => call('GET', `/group/posts?group=${group}&after=${after}`),
    // Collectors Albums (27 Oct 2026). Publishing is signed with this DEVICE's key
    // (a signed-in holder, against spam); deleting with the ALBUM's key (see albumClient).
    publishAlbum: (album) => call('POST', '/albums/publish', { album }),
    deleteAlbum: () => call('POST', '/albums/delete', {}),
    // Comments on NFTs (28 Oct 2026; hiding one: signed with the album key)
    addComment: ({ album, kind, nonce, text }) => call('POST', '/comments/add', { album, kind, nonce, text }),
    voteComment: (comment, vote) => call('POST', '/comments/vote', { comment, vote }),
    deleteComment: (comment) => call('POST', '/comments/delete', { comment }),
    editComment: (comment, text) => call('POST', '/comments/edit', { comment, text }),
    hideComment: (comment, hidden) => call('POST', '/albums/hide-comment', { comment, hidden }),
    // The album mailbox (28 Oct 2026; reply / block: signed with the album key)
    albumTalkSend: (album, items) => call('POST', '/albums/talk/send', { album, items }),
    albumTalk: (after = 0) => call('GET', `/albums/talk?after=${Number(after) || 0}`),
    albumTalkReply: (thread, items) => call('POST', '/albums/talk/reply', { thread, items }),
    albumTalkBlock: (thread, blocked) => call('POST', '/albums/talk/block', { thread, blocked }),
  };
}

/**
 * publicAlbums — reading the Collectors Albums, for everyone (also on the
 * website without signing in: no key, nothing signed). Every album is
 * checked here (its signature and the wallet's proof); damaged ones are left out.
 *   list(before?) → { albums: [{ key, title, name, count, updated }], more }
 *   one(key)      → the checked album (see album.js checkAlbum) or throws
 */
export function publicAlbums({ baseUrl, fetchFn = (...a) => fetch(...a) }) {
  const base = baseUrl.replace(/\/+$/, '');
  async function get(path) {
    let response;
    try {
      response = await fetchFn(base + path, { method: 'GET' });
    } catch {
      throw new Error("Can't reach the albums. Check the internet connection and try again.");
    }
    let answer = null;
    try { answer = await response.json(); } catch { answer = null; }
    if (!response.ok) throw new Error(answer?.error || `The albums answered ${response.status}.`);
    return answer;
  }
  return {
    async list(before = null) {
      const r = await get(`/albums${before ? `?before=${Number(before)}` : ''}`);
      const albums = (Array.isArray(r?.albums) ? r.albums : []).filter((a) => a && typeof a.key === 'string' && typeof a.title === 'string');
      return { albums, more: albums.length >= 50 };
    },
    /** The comments on an album's NFTs (see the postman's GET /comments). */
    async comments(key) {
      const r = await get(`/comments?album=${encodeURIComponent(key)}`);
      return (Array.isArray(r?.comments) ? r.comments : []).filter((c) => c && Number.isInteger(c.id) && typeof c.text === 'string');
    },
    async one(key) {
      const r = await get(`/albums/one?key=${encodeURIComponent(key)}`);
      const checked = checkAlbum(r?.album);
      if (!checked.ok || checked.album.key !== key) throw new Error("This album can't be shown: it doesn't check out.");
      return checked.album;
    },
  };
}
