/**
 * chat/src/index.js — everything the Hub (or another app) uses from the chat core.
 */
export { createIdentity, isPublicKey } from './identity.js';
export { sealDirect, openDirect, DIRECT_KIND } from './direct.js';
export {
  createGroup, nextEpoch, groupKeyMessage, readGroupKeyMessage, sealGroupPost, openGroupPost, acceptPosts,
} from './group.js';
export { issueBadge, checkBadge, BADGE_DAYS } from './badge.js';
export * from './rules.js';
export { createFakePostman } from './fakePostman.js';
