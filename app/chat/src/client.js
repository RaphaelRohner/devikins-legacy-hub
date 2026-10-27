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
  };
}
