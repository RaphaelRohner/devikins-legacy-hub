// Editing and deleting messages and group posts (29 Oct 2026, Raphael):
// "Can it be done like in Telegram ... I would not count this into the daily
// posts ... Maybe it can be only edited twice and only for 24h? I think delete
// should always be available and not impact the count in any direction."
// For all chats: 1:1 messages and group posts, on all of the player's devices.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STATUS } from '../src/messenger.js';
import { world } from './world.mjs';
import { MINUTE, HOUR, MAX_EDITS } from '../src/rules.js';
import { sealGroupEdit, sealGroupDelete } from '../src/group.js';

/** Alice and Bob, contacts. → { alice, bob, aid (Bob in Alice's list), bid (Alice in Bob's list) } */
async function contacts(w) {
  const alice = await w.player('Alice');
  const bob = await w.player('Bob');
  const aid = await alice.requestContact('Bob');
  await bob.checkMail();
  await bob.acceptContact((await bob.listContacts())[0].id);
  await alice.checkMail();
  const bid = (await bob.listContacts())[0].id;
  return { alice, bob, aid, bid };
}

const view = async (m, id) => (await m.messages(id)).map((x) => [x.mine, x.text, x.edits, x.deleted]);

test('1:1: my message can be edited twice within 24 hours, on both sides; free (no extra message); then no more', async () => {
  const w = world();
  const { alice, bob, aid, bid } = await contacts(w);
  await alice.sendMessage(aid, 'Selling a Fire Devikn');
  await bob.checkMail();
  const [mine] = await alice.messages(aid);
  assert.equal(mine.canEdit, true);
  assert.equal(mine.editsLeft, MAX_EDITS);
  assert.match(mine.mid, /^[0-9a-f]{32}$/);

  w.clock.t += MINUTE;
  await alice.editMessage(aid, mine.id, 'Selling a Fire Devikin');
  assert.deepEqual(await bob.checkMail(), { messages: 0, requests: 0, accepted: 0 }); // not a new message
  assert.deepEqual(await view(bob, bid), [[false, 'Selling a Fire Devikin', 1, false]]);
  assert.equal((await bob.listContacts())[0].unread, 0);
  const once = (await alice.messages(aid))[0];
  assert.deepEqual([once.text, once.edited, once.editsLeft, once.canEdit], ['Selling a Fire Devikin', true, 1, true]);

  await alice.editMessage(aid, mine.id, 'Selling a Fire Devikin, 500 KLV');
  await bob.checkMail();
  assert.deepEqual(await view(bob, bid), [[false, 'Selling a Fire Devikin, 500 KLV', 2, false]]);
  assert.equal((await alice.messages(aid))[0].canEdit, false);
  await assert.rejects(alice.editMessage(aid, mine.id, 'third time'), /at most 2 times/);

  // After 24 hours: no edits any more (a new message)
  await alice.sendMessage(aid, 'Still for sale');
  const second = (await alice.messages(aid))[1];
  w.clock.t += 24 * HOUR;
  assert.equal((await alice.messages(aid))[1].canEdit, false);
  await assert.rejects(alice.editMessage(aid, second.id, 'Sold'), /within 24 hours/);
  // Bob's messages aren't Alice's to change
  await bob.checkMail();
  await bob.sendMessage(bid, 'Interested!');
  await alice.checkMail();
  const his = (await alice.messages(aid)).find((m) => !m.mine);
  assert.equal(his.canEdit, false);
  assert.equal(his.canDelete, false);
  await assert.rejects(alice.editMessage(aid, his.id, 'not mine'), /Only your own/);
  await assert.rejects(alice.deleteMessage(aid, his.id), /Only your own/);
});

test('1:1: deleting is always possible (also after 24 hours and two edits) and shows as deleted on both sides', async () => {
  const w = world();
  const { alice, bob, aid, bid } = await contacts(w);
  await alice.sendMessage(aid, 'Oops, wrong chat');
  await alice.sendMessage(aid, 'This one stays');
  await bob.checkMail();
  const [first] = await alice.messages(aid);
  await alice.editMessage(aid, first.id, 'Oops');
  await alice.editMessage(aid, first.id, 'Oops!');
  w.clock.t += 3 * 24 * HOUR;
  assert.equal((await alice.messages(aid))[0].canDelete, true);
  await alice.deleteMessage(aid, first.id);
  await bob.checkMail();
  assert.deepEqual(await view(alice, aid), [[true, '', 2, true], [true, 'This one stays', 0, false]]);
  assert.deepEqual(await view(bob, bid), [[false, '', 2, true], [false, 'This one stays', 0, false]]);
  await assert.rejects(alice.editMessage(aid, first.id, 'back'), /deleted/);
  // (deleting twice does nothing)
  await alice.deleteMessage(aid, first.id);
});

test('1:1: a forged change is ignored - only the author can edit, at most twice, not after a delete', async () => {
  const w = world();
  const { alice, bob, aid, bid } = await contacts(w);
  await alice.sendMessage(aid, 'Original');
  await bob.checkMail();
  const mid = (await alice.messages(aid))[0].mid;
  // Bob's Hub sends an "edit" for Alice's message: Alice's Hub only looks among Bob's messages.
  const bobsContact = (await bob.listContacts())[0];
  const { sealDirect } = await import('../src/direct.js');
  const bobKey = JSON.parse((await bob.db.getAllAsync("SELECT v FROM chat_me WHERE k = 'identity'"))[0].v);
  const aliceDevices = bobsContact.devices;
  const theirCode = (await bob.db.getAllAsync('SELECT their_code FROM chat_contacts'))[0].their_code;
  await bob.postman.drop(theirCode, sealDirect({ from: bobKey, toDevices: aliceDevices, type: 'msg-edit', body: { mid, text: 'Hacked' } }));
  await alice.checkMail();
  assert.deepEqual(await view(alice, aid), [[true, 'Original', 0, false]]);
  // A modified Hub of Alice's sending a third edit: Bob's Hub keeps the limit itself.
  const aliceKey = JSON.parse((await alice.db.getAllAsync("SELECT v FROM chat_me WHERE k = 'identity'"))[0].v);
  const bobCode = (await alice.db.getAllAsync('SELECT their_code FROM chat_contacts'))[0].their_code;
  const bobDevices = (await alice.listContacts())[0].devices;
  for (const text of ['one', 'two', 'three']) {
    await alice.postman.drop(bobCode, sealDirect({ from: aliceKey, toDevices: bobDevices, type: 'msg-edit', body: { mid, text } }));
  }
  await bob.checkMail();
  assert.deepEqual(await view(bob, bid), [[false, 'two', 2, false]]);
  // …and no edit after a delete
  await alice.postman.drop(bobCode, sealDirect({ from: aliceKey, toDevices: bobDevices, type: 'msg-delete', body: { mid } }));
  await alice.postman.drop(bobCode, sealDirect({ from: aliceKey, toDevices: bobDevices, type: 'msg-edit', body: { mid, text: 'back again' } }));
  await bob.checkMail();
  assert.deepEqual(await view(bob, bid), [[false, '', 2, true]]);
  assert.equal((await bob.listContacts())[0].status, STATUS.ACCEPTED);
});

test('1:1: messages from before this update (no id) can\'t be edited or deleted', async () => {
  const w = world();
  const { alice, aid } = await contacts(w);
  await alice.sendMessage(aid, 'Old message');
  await alice.db.runAsync('UPDATE chat_messages SET mid = NULL');
  const [old] = await alice.messages(aid);
  assert.deepEqual([old.canEdit, old.canDelete], [false, false]);
  await assert.rejects(alice.editMessage(aid, old.id, 'new'), /before editing existed/);
});

test('linked devices: an edit or delete on one of my devices shows on the other; a new device gets the changed history', async () => {
  const w = world();
  const { alice, bob, aid } = await contacts(w);
  const phone = await w.player('Alice', 3, alice, 'Android app');
  w.clock.t += 2 * MINUTE;
  await alice.linkedDevices();
  await alice.copyHistoryTo(phone.identity.publicKey);
  await phone.checkMail();
  await phone.linkedDevices(); // (as the chat screen does with every check)
  await alice.sendMessage(aid, 'Hello from the website');
  await alice.sendMessage(aid, 'Delete me');
  await phone.checkMail();
  const pid = (await phone.listContacts())[0].id;
  assert.deepEqual((await phone.messages(pid)).map((m) => m.text), ['Hello from the website', 'Delete me']);
  // Edited on the phone (its own copy has the message's id from the sync)
  const onPhone = await phone.messages(pid);
  assert.equal(onPhone[0].canEdit, true);
  await phone.editMessage(pid, onPhone[0].id, 'Hello from the website (edited on the phone)');
  await alice.checkMail();
  await bob.checkMail();
  assert.deepEqual((await alice.messages(aid)).map((m) => [m.text, m.edits]), [['Hello from the website (edited on the phone)', 1], ['Delete me', 0]]);
  assert.deepEqual((await bob.messages((await bob.listContacts())[0].id)).map((m) => m.text), ['Hello from the website (edited on the phone)', 'Delete me']);
  // Deleted on the website
  await alice.deleteMessage(aid, (await alice.messages(aid))[1].id);
  await phone.checkMail();
  assert.deepEqual((await phone.messages(pid)).map((m) => [m.text, m.deleted]), [['Hello from the website (edited on the phone)', false], ['', true]]);
  // A third device gets the history as it is now (edited text, deleted stays deleted), and may still edit once more
  const tablet = await w.player('Alice', 3, alice, 'Tablet');
  w.clock.t += 2 * MINUTE;
  await alice.linkedDevices();
  await alice.copyHistoryTo(tablet.identity.publicKey);
  await tablet.checkMail();
  const tid = (await tablet.listContacts())[0].id;
  const onTablet = await tablet.messages(tid);
  assert.deepEqual(onTablet.map((m) => [m.text, m.edits, m.deleted]), [['Hello from the website (edited on the phone)', 1, false], ['', 0, true]]);
  assert.equal(onTablet[0].editsLeft, 1);
});

test('the chat backup keeps edits and deletes', async () => {
  const w = world();
  const { alice, aid } = await contacts(w);
  await alice.sendMessage(aid, 'Typo hre');
  await alice.sendMessage(aid, 'Gone');
  const [a, b] = await alice.messages(aid);
  await alice.editMessage(aid, a.id, 'Typo here');
  await alice.deleteMessage(aid, b.id);
  const data = await alice.backupData();
  const other = await w.blank();
  await other.restoreBackupData(data);
  const id = (await other.listContacts())[0].id;
  assert.deepEqual((await other.messages(id)).map((m) => [m.text, m.edits, m.deleted, m.canEdit]), [['Typo here', 1, false, true], ['', 0, true, false]]);
});

/** Alice (owner) and Bob in a group. */
async function inGroup(w) {
  const alice = await w.player('Alice', 3);
  const bob = await w.player('Bob', 50);
  const gid = await alice.startGroup('Fire Breeders');
  await bob.listGroups();
  await bob.joinGroup(gid);
  await alice.checkMail();
  await bob.checkMail();
  return { alice, bob, gid };
}

const posts = async (m, gid) => (await m.groupPosts(gid)).map((p) => [p.text, p.edits, p.deleted]);

test('groups: my post can be edited twice within 24 hours and deleted any time - free, the daily posts stay as they are', async () => {
  const w = world();
  const { alice, bob, gid } = await inGroup(w);
  await bob.postToGroup(gid, 'Who sells a Fire Devikn?');
  const before = await bob.nextGroupPostAt(gid);
  await alice.checkMail();
  const [post] = await bob.groupPosts(gid);
  assert.deepEqual([post.canEdit, post.canDelete, post.editsLeft], [true, true, 2]);
  // (no 10-second gap, no daily allowance)
  await bob.editGroupPost(gid, post.pid, 'Who sells a Fire Devikin?');
  await bob.editGroupPost(gid, post.pid, 'Who sells a Fire Devikin? Up to 800 KLV');
  assert.deepEqual(await bob.nextGroupPostAt(gid), before);
  await assert.rejects(bob.editGroupPost(gid, post.pid, 'third'), /at most 2 times/);
  const unreadBefore = (await alice.listGroups()).find((g) => g.id === gid).unread;
  assert.equal(unreadBefore, 1);
  await alice.checkMail();
  assert.equal((await alice.listGroups()).find((g) => g.id === gid).unread, 1); // edits aren't new posts
  assert.deepEqual(await posts(alice, gid), [['Who sells a Fire Devikin? Up to 800 KLV', 2, false]]);
  // Alice can react and see it; after a delete the reactions go too
  await alice.reactToPost(gid, post.pid, '+1');
  w.clock.t += 25 * HOUR;
  assert.equal((await bob.groupPosts(gid))[0].canEdit, false);
  await bob.deleteGroupPost(gid, post.pid);
  await alice.checkMail();
  const gone = (await alice.groupPosts(gid))[0];
  assert.deepEqual([gone.text, gone.deleted, gone.reactions.counts], ['', true, {}]);
  assert.deepEqual(await posts(bob, gid), [['', 2, true]]);
  // Alice can't change Bob's post
  const p2 = (await alice.groupPosts(gid))[0];
  assert.deepEqual([p2.canEdit, p2.canDelete], [false, false]);
  await assert.rejects(alice.deleteGroupPost(gid, post.pid), /Only your own/);
});

test('groups: a forged edit or delete from another member is ignored; reading the mailbox again doesn\'t count edits twice', async () => {
  const w = world();
  const { alice, bob, gid } = await inGroup(w);
  await bob.postToGroup(gid, 'My post');
  await alice.checkMail();
  const [post] = await alice.groupPosts(gid);
  // Alice's Hub, modified, seals an edit and a delete for Bob's post
  const g = (await alice.db.getAllAsync('SELECT * FROM chat_groups WHERE id = ?', [gid]))[0];
  const aliceKey = JSON.parse((await alice.db.getAllAsync("SELECT v FROM chat_me WHERE k = 'identity'"))[0].v);
  const badge = JSON.parse((await alice.db.getAllAsync("SELECT v FROM chat_me WHERE k = 'badge'"))[0].v);
  const group = { id: g.id, epoch: g.epoch, key: g.key };
  await alice.postman.groupPost(sealGroupEdit({ group, from: aliceKey, postId: post.pid, text: 'Forged', badge, now: w.clock.t }), { reaction: true });
  await alice.postman.groupPost(sealGroupDelete({ group, from: aliceKey, postId: post.pid, badge, now: w.clock.t }), { reaction: true });
  await bob.checkMail();
  await alice.checkMail();
  assert.deepEqual(await posts(bob, gid), [['My post', 0, false]]);
  assert.deepEqual(await posts(alice, gid), [['My post', 0, false]]);
  // Bob edits once; a Hub reading its mailbox again from the start (a new version) keeps it at one edit
  await bob.editGroupPost(gid, post.pid, 'My post (edited)');
  await alice.checkMail();
  await alice.db.runAsync("DELETE FROM chat_me WHERE k = 'group_format'");
  await alice.checkMail();
  assert.deepEqual(await posts(alice, gid), [['My post (edited)', 1, false]]);
  assert.equal((await alice.groupPosts(gid)).length, 1);
});

test('groups: my other device may edit and delete my posts too', async () => {
  const w = world();
  const { alice, bob, gid } = await inGroup(w);
  const phone = await w.player('Bob', 50, bob, 'Android app');
  w.clock.t += 2 * MINUTE;
  await bob.linkedDevices();
  await bob.copyHistoryTo(phone.identity.publicKey);
  await phone.checkMail();
  await phone.linkedDevices();
  await bob.postToGroup(gid, 'Written on the website');
  await phone.checkMail();
  const onPhone = (await phone.groupPosts(gid))[0];
  assert.deepEqual([onPhone.mine, onPhone.canEdit], [true, true]);
  await phone.editGroupPost(gid, onPhone.pid, 'Edited on the phone');
  await alice.checkMail();
  await bob.checkMail();
  assert.deepEqual(await posts(alice, gid), [['Edited on the phone', 1, false]]);
  assert.deepEqual(await posts(bob, gid), [['Edited on the phone', 1, false]]);
  await phone.deleteGroupPost(gid, onPhone.pid);
  await alice.checkMail();
  assert.deepEqual(await posts(alice, gid), [['', 1, true]]);
});
