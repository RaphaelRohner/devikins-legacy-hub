/**
 * ChatGroupView.js — open groups in the Chat screen (stage 3; website and, since 26 Oct 2026, the Android app)
 *
 * GroupsCard: the list on the Chat overview – every open group, the ones
 * you're in first (with new posts counted), "Join" for the others (biggest
 * first, then the latest post), and "Create a group". Groups only their
 * owner is in yet are folded away under "New groups (N)", and go after 30
 * days if nobody joins; starting one takes as many Devikins as voting
 * (Raphael, 24 Oct 2026: against dozens of empty groups crowding the list).
 * ChatGroupView: one group – one line each (opens on a tap) for the owner's
 * pinned messages, open votes (red) and the members; then the posts,
 * and the box to write, which says openly when your next post is possible
 * (as many posts per 24 hours as you hold Devikins, 10 seconds apart).
 *
 * The logic is in app/chat/src/messenger.js; joining works like this: you
 * ask, and the Hub of the first member that's open hands you the group's
 * key (sealed for you) and lets you in. You see posts from then on.
 */

import { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { MAX_TEXT_LENGTH, bandLabel } from '../../chat/src/rules.js';
import { MAX_PINS, POLL_MAX_OPTIONS as MAX_POLL_OPTIONS } from '../../chat/src/group.js';
import ChatMessages from './ChatMessages';
import { CHAT_WALLET, CHAT_HERE } from '../api/chatWallet';


function waitLabel(ms) {
  const min = Math.ceil(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h${min % 60 ? ` ${min % 60} min` : ''}`;
}


function Button({ label, onPress, disabled, quiet, testID }) {
  const { colors } = useTheme();
  return (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.button,
        quiet ? { borderWidth: 1, borderColor: colors.border } : { backgroundColor: colors.primary },
        disabled && { opacity: 0.5 },
      ]}
    >
      <Text style={[styles.buttonText, { color: quiet ? colors.text : colors.primaryText }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function dayLabel(ms) {
  return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export function GroupsCard({ groups, createInfo, busy, onOpen, onJoin, onCreate, onUpdateHoldings }) {
  const { colors } = useTheme();
  const [creating, setCreating] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const list = groups || [];
  const mine = list.filter((g) => g.member);
  // (the postman's order: biggest first, then the latest post)
  const others = list.filter((g) => !g.member);
  // Only their owner in them yet - unless you've asked to join or are in it.
  const isNew = (g) => g.members <= 1 && !g.asking && !g.needsKey && !g.banned;
  const established = others.filter((g) => !isNew(g));
  const newOnes = others.filter(isNew);
  const tooFew = createInfo && !createInfo.allowed;

  const otherRow = (g) => (
    <View key={g.id} style={[styles.row, styles.groupRow, { borderColor: colors.border }]} testID="chat-group-other">
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowName, { color: colors.text }]}>{g.name}</Text>
        {g.description ? <Text style={[styles.note, { color: colors.text }]}>{g.description}</Text> : null}
        <Text style={[styles.note, { color: colors.secondaryText }]}>
          {g.members} member{g.members === 1 ? '' : 's'} · by {g.owner ?? '?'}
          {g.needsKey ? ` · you are in it, but ${CHAT_HERE} has no key yet` : ''}
        </Text>
      </View>
      {g.banned ? (
        <Text style={[styles.note, { color: colors.secondaryText, maxWidth: 220 }]}>
          You were removed by a vote. Only its owner can let you back in (you can ask them in a 1:1 chat).
        </Text>
      ) : g.needsKey ? (
        <Button label="Get the key" onPress={() => onJoin(g.id)} disabled={busy} testID="chat-group-getkey" />
      ) : g.asking ? (
        <Text style={[styles.note, { color: colors.secondaryText, maxWidth: 220 }]} testID="chat-group-waiting">
          Waiting to be let in – happens as soon as a member's Hub is open.
        </Text>
      ) : (
        <Button label="Join" onPress={() => onJoin(g.id)} disabled={busy} testID="chat-group-join" />
      )}
    </View>
  );

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]} testID="chat-groups">
      <Text style={[styles.section, { color: colors.text }]}>Groups</Text>
      {groups === null ? <Text style={[styles.note, { color: colors.secondaryText }]}>Loading the groups…</Text> : null}
      {groups && list.length === 0 ? (
        <Text style={[styles.note, { color: colors.secondaryText }]}>No groups yet. Start the first one!</Text>
      ) : null}
      {mine.map((g) => (
        <TouchableOpacity key={g.id} style={[styles.row, styles.groupRow, { borderColor: colors.border }]} onPress={() => onOpen(g.id)} testID="chat-group">
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowName, { color: colors.text }]}>{g.name}</Text>
            <Text style={[styles.note, { color: colors.secondaryText }]}>
              {g.members} member{g.members === 1 ? '' : 's'}{g.isOwner ? ' · you started it' : ` · by ${g.owner ?? '?'}`}
            </Text>
            {g.removeAt ? (
              <Text style={[styles.note, { color: colors.secondaryText }]} testID="chat-group-remove-at">
                Nobody else has joined yet: the group is removed on {dayLabel(g.removeAt)} unless someone does.
              </Text>
            ) : null}
          </View>
          {g.unread > 0 ? (
            <View style={[styles.badge, { backgroundColor: colors.primary }]}>
              <Text style={[styles.badgeText, { color: colors.primaryText }]}>{g.unread}</Text>
            </View>
          ) : null}
        </TouchableOpacity>
      ))}
      {established.map((g) => otherRow(g))}
      {newOnes.length > 0 ? (
        <TouchableOpacity onPress={() => setShowNew(!showNew)} testID="chat-groups-new-toggle" accessibilityRole="button">
          <Text style={[styles.link, { color: colors.primary }]}>
            New groups ({newOnes.length}) {showNew ? '▴' : '▸'}
          </Text>
        </TouchableOpacity>
      ) : null}
      {showNew ? (
        <>
          <Text style={[styles.note, { color: colors.secondaryText }]}>
            Only their owner is in them yet. A group nobody joins within 30 days is removed.
          </Text>
          {newOnes.map((g) => otherRow(g))}
        </>
      ) : null}
      {creating ? (
        <View style={styles.form}>
          <TextInput
            testID="chat-group-name"
            style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
            value={name}
            onChangeText={setName}
            placeholder="Group name (3–40 characters)"
            placeholderTextColor={colors.secondaryText}
            maxLength={40}
          />
          <TextInput
            testID="chat-group-description"
            style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
            value={description}
            onChangeText={setDescription}
            placeholder="What it's about (optional)"
            placeholderTextColor={colors.secondaryText}
            maxLength={200}
          />
          <Text style={[styles.note, { color: colors.secondaryText }]}>
            Groups are open: every signed-in player sees the name and can join. New members read from the moment they join.
          </Text>
          <View style={styles.row}>
            <Button
              label="Create group"
              testID="chat-group-create"
              disabled={busy || name.trim().length < 3}
              onPress={() => {
                onCreate(name.trim(), description.trim());
                setCreating(false);
                setName('');
                setDescription('');
              }}
            />
            <Button label="Cancel" quiet onPress={() => setCreating(false)} />
          </View>
        </View>
      ) : tooFew ? (
        <View style={styles.form} testID="chat-group-new-too-few">
          <Text style={[styles.note, { color: colors.secondaryText }]}>
            Starting a group takes at least {createInfo.threshold} Devikins, the same as voting (your last sign-in counted{' '}
            {bandLabel(createInfo.nfts)}). You can join any group.
          </Text>
          <TouchableOpacity onPress={onUpdateHoldings} disabled={busy} testID="chat-group-new-update">
            <Text style={[styles.link, { color: colors.primary }]}>Update my holdings</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity onPress={() => setCreating(true)} testID="chat-group-new">
          <Text style={[styles.link, { color: colors.primary }]}>+ Create a group</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function endsLabel(ms) {
  const left = ms - Date.now();
  if (left <= 0) return 'counting now';
  return `ends in ${waitLabel(left)}`;
}

/**
 * One line that opens and closes (Raphael, 23 Oct 2026: with a vote and the
 * pinned messages there was barely room for the chat). Open, its content
 * scrolls inside a limited height, so the posts always stay in view.
 * tone 'danger' = red (removal votes).
 */
function Fold({ title, open, onToggle, tone, testID, children, maxHeight = 280 }) {
  const { colors } = useTheme();
  const danger = tone === 'danger';
  return (
    <View
      style={[styles.pinned, { borderColor: danger ? colors.cancelText : colors.border, backgroundColor: colors.surfaceAlt }]}
      testID={testID}
    >
      <TouchableOpacity onPress={onToggle} style={styles.foldHead} testID={testID ? `${testID}-toggle` : undefined} accessibilityRole="button">
        <Text style={[styles.text, styles.foldTitle, { color: danger ? colors.cancelText : colors.text }]} numberOfLines={open ? undefined : 1}>
          {title}
        </Text>
        <Text style={[styles.link, { color: danger ? colors.cancelText : colors.primary }]}>{open ? 'Close ▴' : 'Open ▾'}</Text>
      </TouchableOpacity>
      {open ? <ScrollView style={{ maxHeight }} contentContainerStyle={{ gap: 6 }}>{children}</ScrollView> : null}
    </View>
  );
}

/** A card inside "Votes & polls": one title line, the details on a tap. */
function Card({ title, tone, open, onToggle, testID, children }) {
  const { colors } = useTheme();
  const danger = tone === 'danger';
  return (
    <View style={[styles.card2, { borderColor: danger ? colors.cancelText : colors.border }]} testID={testID}>
      <TouchableOpacity onPress={onToggle} style={styles.foldHead} testID={testID ? `${testID}-toggle` : undefined} accessibilityRole="button">
        <Text style={[styles.note, styles.foldTitle, { color: danger ? colors.cancelText : colors.text }]}>{title}</Text>
        <Text style={[styles.note, { color: danger ? colors.cancelText : colors.primary, fontWeight: '700' }]}>{open ? '▴' : '▾'}</Text>
      </TouchableOpacity>
      {open ? <View style={{ gap: 6, marginTop: 6 }}>{children}</View> : null}
    </View>
  );
}

function voteTitle(v) {
  const who = v.accused ?? 'a former player';
  if (v.decided) {
    if (!v.passed) return `🗳 Vote ended: ${who} stays (${v.valid ? 'not enough yes votes' : 'too few votes'}).`;
    return v.removed ? `🗳 Vote ended: ${who} was removed.` : `🗳 Vote passed: ${who} had left already and can't rejoin.`;
  }
  return `🗳 Vote: remove ${who}? · ${v.yes} yes / ${v.no} no · ${endsLabel(v.endsAt)}`;
}

/** One removal vote (open, or from the group's history). */
function VoteCard({ v, votes, busy, open, onToggle, onCastVote, onUpdateHoldings }) {
  const { colors } = useTheme();
  const mayVoteNow = !v.decided && !v.aboutMe && !v.myBallot && v.mayVote && votes?.canVote;
  return (
    <Card title={`${voteTitle(v)}${mayVoteNow ? ' · your vote?' : ''}`} tone={v.decided ? null : 'danger'} open={open} onToggle={onToggle} testID="chat-group-vote">
      <Text style={[styles.note, { color: colors.text }]}>Reason: {v.reason ?? '(given before you joined)'}</Text>
      <Text style={[styles.note, { color: colors.secondaryText }]}>
        Started by {v.opener ?? 'a former player'} on {dateLabel(v.openedAt)} · {v.decided
          ? `${v.ballots.filter((b) => b.counts && b.yes).length} yes / ${v.ballots.filter((b) => b.counts && !b.yes).length} no counted`
          : `${v.yes} yes / ${v.no} no`}
        {v.ballots.length ? ` · ${v.ballots.map((b) => `${b.voter ?? '?'} ${b.yes ? 'yes' : 'no'}${v.decided && !b.counts ? ' (didn\'t count)' : ''}`).join(', ')}` : ''}
      </Text>
      {!v.decided && v.aboutMe ? (
        <Text style={[styles.note, { color: colors.secondaryText }]}>
          This vote is about you, so you can't vote. You can write to the group's owner in a 1:1 chat.
        </Text>
      ) : null}
      {!v.decided && !v.aboutMe && v.myBallot ? (
        <Text style={[styles.note, { color: colors.secondaryText }]}>You voted {v.myBallot.yes ? 'yes' : 'no'}.</Text>
      ) : null}
      {!v.decided && !v.aboutMe && !v.myBallot && !v.mayVote ? (
        <Text style={[styles.note, { color: colors.secondaryText }]}>You joined after this vote started, so you can't vote in it.</Text>
      ) : null}
      {!v.decided && !v.aboutMe && !v.myBallot && v.mayVote ? (
        votes?.canVote ? (
          <View style={styles.row}>
            <Button label={`Yes, remove ${v.accused}`} onPress={() => onCastVote(v.id, true)} disabled={busy} testID="chat-vote-yes" />
            <Button label="No" quiet onPress={() => onCastVote(v.id, false)} disabled={busy} testID="chat-vote-no" />
          </View>
        ) : (
          <View>
            <Text style={[styles.note, { color: colors.secondaryText }]}>
              Members holding at least {votes?.threshold} Devikins can vote.
            </Text>
            <HoldingsNote votes={votes} busy={busy} onUpdateHoldings={onUpdateHoldings} />
          </View>
        )
      ) : null}
      {!v.decided ? (
        <Text style={[styles.note, { color: colors.secondaryText }]}>
          A vote counts if at least 10 % of the members (never fewer than 3) vote; 60 % yes removes the member. It ends early once the result can't change any more (60 % of everyone allowed to vote said yes, or more than 40 % said no). Voting asks your
          {CHAT_WALLET} to sign a short text (no fee); your wallet is checked again when the vote closes, then forgotten.
        </Text>
      ) : null}
    </Card>
  );
}

function dateLabel(ms) {
  return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

function pollStatus(p) {
  if (p.open) return endsLabel(p.endsAt);
  const at = p.closedAt && p.closedAt < p.endsAt ? p.closedAt : p.endsAt;
  return `${p.closedAt && p.closedAt < p.endsAt ? 'closed' : 'ended'} ${dateLabel(at)}`;
}

/** One poll: the answers with their votes (tap one to vote while it's open). */
function PollCard({ p, busy, open, onToggle, onVote, onClose }) {
  const { colors } = useTheme();
  const total = p.counts.reduce((a, b) => a + b, 0);
  const lead = Math.max(0, ...p.counts);
  const yourTurn = p.open && p.myChoice === null;
  return (
    <Card
      title={`📊 ${p.question} · ${total} vote${total === 1 ? '' : 's'} · ${pollStatus(p)}${yourTurn ? ' · your vote?' : ''}`}
      open={open}
      onToggle={onToggle}
      testID="chat-group-poll"
    >
      <Text style={[styles.note, { color: colors.secondaryText }]}>
        Poll by {p.creator ?? 'a former member'} on {dateLabel(p.openedAt)}
        {p.open ? ' · one vote each, you can change it until the end' : ''}
      </Text>
      {p.options.map((o, i) => {
        const n = p.counts[i];
        const share = total ? n / total : 0;
        const mineHere = p.myChoice === i;
        const won = !p.open && n > 0 && n === lead;
        const voters = p.voters.filter((v) => v.choice === i).map((v) => v.nickname ?? '?');
        return (
          <TouchableOpacity
            key={i}
            disabled={!p.open || busy}
            onPress={() => onVote(p.id, mineHere ? null : i)}
            style={[styles.pollOption, { borderColor: mineHere ? colors.primary : colors.border }]}
            accessibilityLabel={`${o}: ${n} vote${n === 1 ? '' : 's'}${mineHere ? ', your vote' : ''}`}
            testID="chat-poll-option"
          >
            <View style={[styles.pollBar, { width: `${Math.round(share * 100)}%`, backgroundColor: colors.primary }]} />
            <View style={styles.pollOptionRow}>
              <Text style={[styles.note, { color: colors.text, flex: 1, fontWeight: won || mineHere ? '700' : '400' }]}>
                {mineHere ? '✓ ' : ''}{o}
              </Text>
              <Text style={[styles.note, { color: colors.text, fontWeight: '700' }]}>{n}</Text>
            </View>
            {voters.length ? <Text style={[styles.small, { color: colors.secondaryText }]}>{voters.join(', ')}</Text> : null}
          </TouchableOpacity>
        );
      })}
      {p.open && p.myChoice !== null ? (
        <Text style={[styles.small, { color: colors.secondaryText }]}>Tap another answer to change your vote, or yours again to take it back.</Text>
      ) : null}
      {p.open && p.mine ? (
        <TouchableOpacity onPress={() => onClose(p.id)} disabled={busy} testID="chat-poll-close">
          <Text style={[styles.link, { color: colors.cancelText }]}>Close this poll now</Text>
        </TouchableOpacity>
      ) : null}
    </Card>
  );
}

const POLL_DURATIONS = [
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '6 hours', ms: 6 * 60 * 60 * 1000 },
  { label: '1 day', ms: 24 * 60 * 60 * 1000 },
  { label: '3 days', ms: 3 * 24 * 60 * 60 * 1000 },
  { label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
];

function PollForm({ busy, onStart, onCancel }) {
  const { colors } = useTheme();
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [duration, setDuration] = useState(POLL_DURATIONS[2].ms);
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const inputStyle = [styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }];
  return (
    <View style={styles.form} testID="chat-poll-form">
      <TextInput testID="chat-poll-question" style={inputStyle} value={question} onChangeText={setQuestion} maxLength={300}
        placeholder="Your question" placeholderTextColor={colors.secondaryText} />
      {options.map((o, i) => (
        <TextInput
          key={i}
          testID="chat-poll-answer"
          style={inputStyle}
          value={o}
          onChangeText={(t) => setOptions(options.map((x, j) => (j === i ? t : x)))}
          maxLength={80}
          placeholder={`Answer ${i + 1}`}
          placeholderTextColor={colors.secondaryText}
        />
      ))}
      {options.length < MAX_POLL_OPTIONS ? (
        <TouchableOpacity onPress={() => setOptions([...options, ''])} testID="chat-poll-add-answer">
          <Text style={[styles.link, { color: colors.primary }]}>+ Another answer</Text>
        </TouchableOpacity>
      ) : null}
      <View style={styles.row}>
        <Text style={[styles.note, { color: colors.secondaryText }]}>Runs for</Text>
        {POLL_DURATIONS.map((d) => (
          <TouchableOpacity
            key={d.ms}
            onPress={() => setDuration(d.ms)}
            style={[styles.chip, { borderColor: duration === d.ms ? colors.primary : colors.border, backgroundColor: duration === d.ms ? colors.primary : 'transparent' }]}
            testID="chat-poll-duration"
          >
            <Text style={[styles.small, { color: duration === d.ms ? colors.primaryText : colors.text }]}>{d.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={[styles.small, { color: colors.secondaryText }]}>
        Every member has one vote and sees who voted what. Starting a poll counts as one of your posts; voting is free.
      </Text>
      <View style={styles.row}>
        <Button
          label="Start the poll"
          testID="chat-poll-start"
          disabled={busy || !question.trim() || new Set(filled).size < 2}
          onPress={() => onStart(question.trim(), filled, duration)}
        />
        <Button label="Cancel" quiet onPress={onCancel} />
      </View>
    </View>
  );
}

/**
 * "🗳 Votes & polls" (25 Oct 2026, Raphael): one line for removal votes and
 * polls. Open ones first (newest on top, removal votes red), then "Past"
 * folded again - kept for good in this Hub, so a guild can look back later.
 */
function VotesAndPolls({ votes, polls, busy, onCastVote, onUpdateHoldings, onStartPoll, onVotePoll, onClosePoll, focus }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const [openCard, setOpenCard] = useState(null);
  const [showPast, setShowPast] = useState(false);
  useEffect(() => {
    if (!focus) return;
    setOpen(true);
    setOpenCard(`poll:${focus.id}`);
    if ((polls || []).some((p) => p.id === focus.id && !p.open)) setShowPast(true);
  }, [focus]);
  const [creating, setCreating] = useState(false);
  const openVotes = (votes?.votes || []).filter((v) => !v.decided);
  const pastVotes = votes?.history || (votes?.votes || []).filter((v) => v.decided);
  const items = [
    ...openVotes.map((v) => ({ type: 'vote', at: v.openedAt, v })),
    ...(polls || []).filter((p) => p.open).map((p) => ({ type: 'poll', at: p.openedAt, p })),
  ].sort((a, b) => b.at - a.at);
  const past = [
    ...pastVotes.map((v) => ({ type: 'vote', at: v.openedAt, v })),
    ...(polls || []).filter((p) => !p.open).map((p) => ({ type: 'poll', at: p.openedAt, p })),
  ].sort((a, b) => b.at - a.at);
  const yourTurn = openVotes.some((v) => !v.aboutMe && !v.myBallot && v.mayVote && votes?.canVote) || (polls || []).some((p) => p.open && p.myChoice === null);
  const title = `🗳 Votes & polls${items.length ? ` · ${items.length} open` : ''}${yourTurn ? ' · your vote?' : ''}${past.length ? ` · ${past.length} past` : ''}`;
  const card = (x) => {
    const key = `${x.type}:${x.type === 'vote' ? x.v.id : x.p.id}`;
    const toggle = () => setOpenCard(openCard === key ? null : key);
    return x.type === 'vote' ? (
      <VoteCard key={key} v={x.v} votes={votes} busy={busy} open={openCard === key} onToggle={toggle} onCastVote={onCastVote} onUpdateHoldings={onUpdateHoldings} />
    ) : (
      <PollCard key={key} p={x.p} busy={busy} open={openCard === key} onToggle={toggle} onVote={onVotePoll} onClose={onClosePoll} />
    );
  };
  return (
    <Fold
      title={title}
      open={open}
      onToggle={() => setOpen(!open)}
      tone={openVotes.length ? 'danger' : null}
      testID="chat-group-votes"
      maxHeight={420}
    >
      {items.length === 0 && !creating ? (
        <Text style={[styles.note, { color: colors.secondaryText }]}>Nothing open right now.</Text>
      ) : null}
      {items.map(card)}
      {creating ? (
        <PollForm
          busy={busy}
          onCancel={() => setCreating(false)}
          onStart={async (q, o, d) => {
            if (await onStartPoll(q, o, d)) setCreating(false);
          }}
        />
      ) : (
        <TouchableOpacity onPress={() => setCreating(true)} testID="chat-poll-new">
          <Text style={[styles.link, { color: colors.primary }]}>+ Start a poll</Text>
        </TouchableOpacity>
      )}
      {past.length ? (
        <TouchableOpacity onPress={() => setShowPast(!showPast)} testID="chat-votes-past-toggle">
          <Text style={[styles.link, { color: colors.primary }]}>Past ({past.length}) {showPast ? '▴' : '▸'}</Text>
        </TouchableOpacity>
      ) : null}
      {showPast ? past.map(card) : null}
      <Text style={[styles.small, { color: colors.secondaryText }]}>
        To start a vote to remove someone: 👥 Members. Past votes and polls stay in {CHAT_HERE}{Platform.OS === 'web' ? ' (and in your backup)' : ''}.
      </Text>
    </Fold>
  );
}

/** The members (inside the "Members" line), with "start a vote" (and, for the owner, letting removed members back in). */
/** "Your sign-in counted N Devikins" + "Update my holdings": the vote
 *  buttons go by the count from the chat sign-in, which can be older than
 *  the wallet's NFTs (Raphael, 23 Oct 2026). */
function HoldingsNote({ votes, busy, onUpdateHoldings }) {
  const { colors } = useTheme();
  if (!onUpdateHoldings) return null;
  return (
    <View style={styles.row}>
      <Text style={[styles.note, { color: colors.secondaryText, flex: 1 }]}>
        Your chat sign-in counted {bandLabel(votes.myNfts ?? 0)} Devikin{votes.myNfts === 1 ? '' : 's'}. Got more since?
      </Text>
      <TouchableOpacity onPress={onUpdateHoldings} disabled={busy} testID="chat-update-holdings">
        <Text style={[styles.link, { color: colors.primary }]}>Update my holdings</Text>
      </TouchableOpacity>
    </View>
  );
}

function MembersPanel({ group, me, votes, busy, loadMembers, onOpenVote, onLetBackIn, onUpdateHoldings, onLeave }) {
  const { colors } = useTheme();
  const [members, setMembers] = useState(null);
  const [voting, setVoting] = useState(null);
  const [reason, setReason] = useState('');
  useEffect(() => {
    let alive = true;
    loadMembers().then((m) => alive && setMembers(m)).catch(() => alive && setMembers([]));
    return () => { alive = false; };
    // (loaded once each time the panel opens)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const open = new Set((votes?.votes || []).filter((v) => !v.decided).map((v) => v.accused));
  return (
    <View style={{ gap: 6 }}>
      {members === null ? <Text style={[styles.note, { color: colors.secondaryText }]}>Loading…</Text> : null}
      {(members || []).map((name) => (
        <View key={name} style={[styles.row, styles.pinItem]} testID="chat-group-member">
          <Text style={[styles.text, { color: colors.text, flex: 1 }]}>{name}{name === group.owner ? ' (owner)' : ''}</Text>
          {/* Leaving sits next to your own name (Raphael, 24 Oct 2026: at the
              top of the group, next to "‹", it was too easy to hit). */}
          {name === me ? (
            <TouchableOpacity onPress={onLeave} disabled={busy} testID="chat-group-leave">
              <Text style={[styles.link, { color: colors.cancelText }]}>Leave this group</Text>
            </TouchableOpacity>
          ) : null}
          {name !== group.owner && name !== me && !open.has(name) && (votes?.canVote || group.isOwner) && votes?.canOpen && voting !== name ? (
            <TouchableOpacity onPress={() => { setVoting(name); setReason(''); }} testID="chat-vote-start">
              <Text style={[styles.link, { color: colors.cancelText }]}>Start a vote to remove</Text>
            </TouchableOpacity>
          ) : null}
          {open.has(name) ? <Text style={[styles.note, { color: colors.secondaryText }]}>vote open</Text> : null}
          {voting === name ? (
            <View style={[styles.form, { width: '100%' }]}>
              <TextInput
                testID="chat-vote-reason"
                style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
                value={reason}
                onChangeText={setReason}
                placeholder={`Why should ${name} be removed? (seen by the group)`}
                placeholderTextColor={colors.secondaryText}
                maxLength={500}
              />
              <View style={styles.row}>
                <Button
                  label="Start the vote"
                  testID="chat-vote-open"
                  disabled={busy || !reason.trim()}
                  onPress={async () => { if (await onOpenVote(name, reason)) setVoting(null); }}
                />
                <Button label="Cancel" quiet onPress={() => setVoting(null)} />
              </View>
              <Text style={[styles.note, { color: colors.secondaryText }]}>
                You can start one vote per week. It runs 48 hours; once a second member supports it, {name} can't post until it's decided.
              </Text>
            </View>
          ) : null}
        </View>
      ))}
      {votes && !votes.canVote ? (
        <>
          <Text style={[styles.note, { color: colors.secondaryText }]}>
            {group.isOwner
              ? `As the owner you can start a vote; your own "yes" counts once you hold at least ${votes.threshold} Devikins. The members holding that many decide.`
              : `Members holding at least ${votes.threshold} Devikins can start and cast votes.`}
          </Text>
          <HoldingsNote votes={votes} busy={busy} onUpdateHoldings={onUpdateHoldings} />
        </>
      ) : null}
      {votes && votes.canVote && !votes.canOpen ? (
        <Text style={[styles.note, { color: colors.secondaryText }]}>You started a vote in the last 7 days; one per week.</Text>
      ) : null}
      {group.isOwner && votes?.banned?.length ? (
        <>
          <Text style={[styles.text, { color: colors.text, fontWeight: '700' }]}>Removed by a vote</Text>
          {votes.banned.map((b) => (
            <View key={b.id} style={styles.row} testID="chat-group-banned">
              <Text style={[styles.text, { color: colors.text, flex: 1 }]}>{b.nickname ?? 'a former player'}</Text>
              <Button label="Let back in" quiet onPress={() => onLetBackIn(b.id)} disabled={busy} testID="chat-group-unban" />
            </View>
          ))}
        </>
      ) : null}
    </View>
  );
}

export default function ChatGroupView({
  group, me, posts, next, busy, error, onBack, onPost, onPins, onReact, onEditPost, onDeletePost, onLeave, votes, polls, loadMembers, onOpenVote, onCastVote, onLetBackIn, onUpdateHoldings,
  onStartPoll, onVotePoll, onClosePoll,
}) {
  const [showMembers, setShowMembers] = useState(false);
  // A poll to open in "Votes & polls" (tapped in the chat)
  const [pollFocus, setPollFocus] = useState(null);
  const [showPins, setShowPins] = useState(false);
  const { colors } = useTheme();
  const [draft, setDraft] = useState('');
  // Which pinned message the owner is editing: its number, 'new', or null.
  const [editingPin, setEditingPin] = useState(null);
  const [pinDraft, setPinDraft] = useState('');
  const [, setTick] = useState(0);
  const scrollRef = useRef(null);
  const shownPosts = useRef('');

  // Keep "next post possible in …" fresh.
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 5000); // (the 10-second pause between posts)
    return () => clearInterval(timer);
  }, []);

  const pins = group.pinned?.pins || [];
  const savePin = () => {
    const text = pinDraft.trim();
    const list = [...pins];
    if (editingPin === 'new') {
      if (text) list.push(text);
    } else if (text) {
      list[editingPin] = text;
    } else {
      list.splice(editingPin, 1);
    }
    onPins(list);
    setEditingPin(null);
  };
  const pinEditor = (
    <View key="editor" style={styles.form}>
      <TextInput
        testID="chat-group-pin-draft"
        style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background, minHeight: 70 }]}
        value={pinDraft}
        onChangeText={setPinDraft}
        multiline
        autoFocus
        maxLength={MAX_TEXT_LENGTH}
        placeholder="Rules or important info for everyone"
        placeholderTextColor={colors.secondaryText}
      />
      <View style={styles.row}>
        <Button label="Save" testID="chat-group-pin-save" disabled={busy} onPress={savePin} />
        <Button label="Cancel" quiet onPress={() => setEditingPin(null)} />
      </View>
    </View>
  );

  const waitMs = next?.allowedAt ? Math.max(0, next.allowedAt - Date.now()) : 0;
  const canPost = next?.allowedAt !== null && next?.allowedAt !== undefined && waitMs === 0 && !group.pausedUntil;

  const send = async () => {
    if (!draft.trim() || busy || !canPost) return;
    // The text stays in the box if posting fails, so it can be sent again.
    if (await onPost(draft)) setDraft('');
  };

  const leave = () => Alert.alert(
    `Leave ${group.name}?`,
    group.isOwner
      ? 'You started this group: if you leave, it goes to the member who joined first (your pinned messages are removed). If you are the last one, the group is deleted.'
      : `Its posts are deleted from ${CHAT_HERE}. You can ask to join again later.`,
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Leave', style: 'destructive', onPress: onLeave },
    ],
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.topRow}>
        <TouchableOpacity style={[styles.backButton, { backgroundColor: colors.primary }]} onPress={onBack} accessibilityLabel="Back">
          <Text style={[styles.backButtonText, { color: colors.primaryText }]}>‹</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{group.name}</Text>
          <Text style={[styles.note, { color: colors.secondaryText }]}>
            {group.members} member{group.members === 1 ? '' : 's'} · {group.isOwner ? 'you started it' : `by ${group.owner ?? '?'}`}
          </Text>
        </View>
      </View>

      {/* Pinned, votes & polls, members: at most 45 % of the chat's height, scrolling
          inside, so the posts and the message box always keep room (25 Oct 2026). */}
      <ScrollView style={styles.topPart} contentContainerStyle={{ paddingBottom: 2 }}>
      {group.pinned || group.isOwner ? (
        <Fold
          title={pins.length
            ? `📌 Pinned${pins.length > 1 ? ` (${pins.length})` : ''}: ${pins[0].split('\n').find((l) => l.trim()) || ''}`
            : '📌 Pinned by the owner: nothing yet'}
          open={showPins}
          onToggle={() => setShowPins((x) => !x)}
          testID="chat-group-pinned"
        >
          {pins.length === 0 && group.isOwner && editingPin === null ? (
            <Text style={[styles.note, { color: colors.secondaryText }]}>Nothing pinned yet. Pin rules or important info for everyone.</Text>
          ) : null}
          {pins.map((text, i) => (editingPin === i ? pinEditor : (
            <View key={i} style={[styles.pinItem, i > 0 && { borderTopWidth: 1, borderColor: colors.border }]} testID="chat-group-pin">
              <Text selectable style={[styles.text, { color: colors.text }]}>{text}</Text>
              {group.isOwner && editingPin === null ? (
                <View style={styles.row}>
                  <TouchableOpacity onPress={() => { setPinDraft(text); setEditingPin(i); }} testID="chat-group-pin-edit">
                    <Text style={[styles.link, { color: colors.primary }]}>Edit</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => onPins(pins.filter((_, k) => k !== i))} testID="chat-group-pin-remove">
                    <Text style={[styles.link, { color: colors.cancelText }]}>Remove</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
          )))}
          {editingPin === 'new' ? pinEditor : null}
          {group.isOwner && editingPin === null && pins.length < MAX_PINS ? (
            <TouchableOpacity onPress={() => { setPinDraft(''); setEditingPin('new'); }} testID="chat-group-pin-add">
              <Text style={[styles.link, { color: colors.primary }]}>+ Pin a message{pins.length ? ` (${pins.length} of ${MAX_PINS})` : ''}</Text>
            </TouchableOpacity>
          ) : null}
        </Fold>
      ) : null}

      <VotesAndPolls
        votes={votes}
        polls={polls}
        busy={busy}
        onCastVote={onCastVote}
        onUpdateHoldings={onUpdateHoldings}
        onStartPoll={onStartPoll}
        onVotePoll={onVotePoll}
        onClosePoll={onClosePoll}
        focus={pollFocus}
      />

      <Fold
        title={`👥 Members (${group.members})`}
        open={showMembers}
        onToggle={() => setShowMembers((x) => !x)}
        testID="chat-group-members"
      >
        <MembersPanel
          group={group}
          me={me}
          votes={votes}
          busy={busy}
          loadMembers={loadMembers}
          onOpenVote={onOpenVote}
          onLetBackIn={onLetBackIn}
          onUpdateHoldings={onUpdateHoldings}
          onLeave={leave}
        />
      </Fold>

      {group.pausedUntil ? (
        <Text style={[styles.note, styles.pad, { color: colors.cancelText }]} testID="chat-group-paused">
          Your posting here is paused while a vote about you is open ({endsLabel(group.pausedUntil)}). You can write to the owner in a 1:1 chat.
        </Text>
      ) : null}
      </ScrollView>

      <ScrollView
        ref={scrollRef}
        style={[styles.threadArea, { borderColor: colors.border }]}
        contentContainerStyle={styles.thread}
        // (to the newest post when one arrives or the group opens - not when something
        // opens under a post, e.g. the emojis or the edit box: 29 Oct 2026)
        onContentSizeChange={() => {
          const key = `${group.id}:${posts.length}:${(polls || []).length}`;
          if (shownPosts.current === key) return;
          shownPosts.current = key;
          scrollRef.current?.scrollToEnd({ animated: false });
        }}
      >
        {posts.length === 0 ? (
          <Text style={[styles.note, { color: colors.secondaryText, textAlign: 'center' }]}>No posts yet since you joined.</Text>
        ) : null}
        <ChatMessages
          scrollRef={scrollRef}
          showAuthors
          busy={busy}
          onReact={onReact}
          onEdit={onEditPost ? (m, text) => onEditPost(m.pid, text) : null}
          onDelete={onDeletePost ? (m) => onDeletePost(m.pid) : null}
          items={[
            ...posts.map((p) => ({
              id: p.id, pid: p.pid, reactions: p.reactions, mine: p.mine, author: p.author, nickname: p.nickname, text: p.text, at: p.receivedAt,
              // (editing and deleting my own posts, 29 Oct 2026)
              edited: p.edited, deleted: p.deleted, canEdit: p.canEdit, canDelete: p.canDelete, editsLeft: p.editsLeft,
            })),
            // New polls show as a line in the chat too; a tap opens them above (25 Oct 2026)
            ...(polls || []).map((p) => ({
              id: `poll-${p.id}`,
              at: p.openedAt,
              system: `📊 ${p.mine ? 'You' : p.creator ?? 'A member'} started a poll: ${p.question}`,
              onPress: () => setPollFocus({ id: p.id, n: Date.now() }),
            })),
          ].sort((a, b) => a.at - b.at)}
        />
      </ScrollView>

      {error ? <Text style={[styles.note, styles.pad, { color: colors.cancelText }]} testID="chat-error">{error}</Text> : null}
      <View style={[styles.composer, { borderColor: colors.border }]}>
        <Text style={[styles.note, { color: colors.secondaryText }]} testID="chat-group-limit">
          {next?.allowedAt === null || next?.allowedAt === undefined
            ? 'Please sign in again to post (your weekly check has run out).'
            : next.owner
              ? "As the group's owner you can always answer (one post every 10 seconds)."
              : next.left === 0
                ? `You've used your ${next.perDay} post${next.perDay === 1 ? '' : 's'} for the last 24 hours (one per Devikin, counted in steps: ${bandLabel(next.nfts)}). Next post possible in ${waitLabel(waitMs)}.`
                : `${next.left} of ${next.perDay} post${next.perDay === 1 ? '' : 's'} left for today (one per Devikin, counted in steps: ${bandLabel(next.nfts)}).${waitMs > 0 ? ' One moment…' : ''}`}
        </Text>
        <View style={styles.row}>
          <TextInput
            testID="chat-group-draft"
            style={[styles.input, { flex: 1, color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
            value={draft}
            onChangeText={setDraft}
            placeholder={canPost ? `Post in ${group.name}` : 'Not yet – see above'}
            placeholderTextColor={colors.secondaryText}
            maxLength={MAX_TEXT_LENGTH}
            onSubmitEditing={send}
            blurOnSubmit={false}
            editable={canPost}
          />
          <Button label="Post" onPress={send} disabled={!canPost || !draft.trim() || busy} testID="chat-group-post" />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topRow: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 12, marginVertical: 12, gap: 8 },
  backButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  backButtonText: { fontSize: 22, fontWeight: '700', lineHeight: 24 },
  title: { fontSize: 18, fontWeight: '700' },
  card: { marginHorizontal: 12, padding: 16, borderRadius: 12, borderWidth: 1, gap: 12, maxWidth: 720 },
  section: { fontSize: 16, fontWeight: '700' },
  text: { fontSize: 15, lineHeight: 20 },
  note: { fontSize: 13, lineHeight: 18 },
  link: { fontSize: 14, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  groupRow: { borderTopWidth: 1, paddingTop: 10 },
  rowName: { fontSize: 15, fontWeight: '600' },
  badge: { minWidth: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  badgeText: { fontSize: 12, fontWeight: '700' },
  button: { paddingVertical: 9, paddingHorizontal: 14, borderRadius: 8, alignItems: 'center' },
  buttonText: { fontSize: 14, fontWeight: '700' },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9, fontSize: 15 },
  form: { gap: 10 },
  pinned: { marginHorizontal: 12, marginBottom: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, borderWidth: 1, gap: 6, maxWidth: 720 },
  pinItem: { gap: 4, paddingTop: 6 },
  foldHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  foldTitle: { flex: 1, fontWeight: '700' },
  card2: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7 },
  small: { fontSize: 12, lineHeight: 16 },
  chip: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 3 },
  pollOption: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, overflow: 'hidden', gap: 2 },
  pollBar: { position: 'absolute', left: 0, top: 0, bottom: 0, opacity: 0.18 },
  pollOptionRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // (a line and some room between the pinned / vote / members lines and the posts - Raphael, 24 Oct 2026)
  topPart: { flexGrow: 0, flexShrink: 1, maxHeight: '45%' },
  threadArea: { flex: 1, marginTop: 6, borderTopWidth: 1 },
  thread: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 12, maxWidth: 720, width: '100%' },
  pad: { marginHorizontal: 12 },
  composer: { padding: 12, borderTopWidth: 1, gap: 8, maxWidth: 744 },
});
