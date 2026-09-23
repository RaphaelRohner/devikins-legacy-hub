/**
 * HelpAssistant.js
 *
 * "Devi" - a tiny, entirely offline, definitely-not-a-real-AI helper
 * built into the app. Its origin is exactly what it sounds like: asked
 * (as a joke) for "a downgraded version of you" inside the app, so this
 * is that - a chat-shaped screen that matches whatever you type against
 * a small, fixed list of canned answers about using THIS app (adding a
 * wallet, what Fetch/Update does, filters, ratings, feedback, etc.).
 * There's no language model here, no network call, no API key, nothing
 * that costs money or needs a backend - just keyword matching against
 * FAQ_ENTRIES below (see matchEntry/scoreEntry further down - it's a
 * little smarter than plain substring matching: it tolerates small
 * typos and simple word variations, e.g. "walet"/"wallets" both still
 * find the wallet answer, without needing an exact keyword substring).
 * A real AI chat (calling an actual LLM API) would need a backend
 * server to hold the API key safely and would cost real money per
 * message - a genuinely different, bigger project than this, and not
 * what this screen is (asked about directly, and kept as a free,
 * offline FAQ on purpose - see NOTES.md).
 *
 * Devi is upfront about all of this the moment you open the screen and
 * whenever it can't match your question - it should never come across
 * as more capable than it actually is.
 *
 * Every FAQ_ENTRIES question/answer pair is shown as a plain, always-
 * visible list - each answer stacked directly under its own question,
 * one after another - rather than hidden behind tappable chips you'd
 * have to try one at a time to see what's there. The free-text input at
 * the bottom still exists for anything not already covered, and typed
 * questions get their own answer appended below the list as a small
 * chat exchange.
 *
 * Same full-screen-takeover pattern as WalletManager.js/Feedback.js -
 * this is App.js's seventh "screen" (`currentScreen === 'help'`), opened
 * from the hamburger menu, with its own small round "‹" back button in
 * the top-left corner (see Feedback.js's file comment - all four of
 * these screens' back buttons were shortened from "‹ Back to Home" to
 * just the arrow, per feedback).
 */

import { useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';

// The whole "brain" - a fixed list of question/answer pairs, each with a
// handful of keywords that, if typed, should surface that answer. This
// is intentionally small and specific to THIS app, not general
// knowledge - Devi doesn't know anything it isn't told here.
const FAQ_ENTRIES = [
  {
    id: 'add-wallet',
    question: 'How do I add a wallet?',
    keywords: ['wallet', 'address', 'klv1', 'wallets', 'connect'],
    answer:
      "Open the ☰ menu and tap Wallets. Paste your Klever wallet address (starts with klv1...) and tap Add. You can add as many wallets as you like, and give each one a nickname from its Edit button.",
  },
  {
    id: 'fetch-update',
    question: 'What does Fetch/Update do?',
    keywords: ['fetch', 'update', 'scan', 'refresh', 'sync'],
    answer:
      "It asks the Klever blockchain which Devikins, Weapons, and Equipment your wallet(s) hold, then downloads each one's details and picture. The first fetch takes the longest since nothing's cached yet - after that, it's much faster. There's no automatic background fetching - it only ever runs when you tap Fetch/Update yourself, so if anything's stuck, just tap it again.",
  },
  {
    id: 'deleted',
    question: "What does marking something 'Deleted' do?",
    keywords: ['delete', 'deleted', 'hide', 'sold', 'restore', 'remove', 'traded'],
    answer:
      "It's a personal organizing flag only - nothing is removed from the blockchain, or even from this app's own database. It greys the item out (or hides it entirely if you switch on the Deleted filter) so your list stays tidy, and you can tap Restore on it any time. One thing to know: if you still hold the NFT, the next Fetch/Update will automatically un-delete it, since successfully re-fetching it is proof you still own it.",
  },
  {
    id: 'list-tiles',
    question: "What's the difference between List and Tiles view?",
    keywords: ['list', 'tiles', 'grid', 'view', 'layout'],
    answer:
      "List shows a picture plus a few key stats for each item; Tiles shows a compact grid of just the pictures, so you can scan a big collection faster. Each of Devikins/Weapons/Equipment remembers its own choice.",
  },
  {
    id: 'search-star-filter',
    question: 'How do search and the star filter work?',
    keywords: ['search', 'star filter', 'filter'],
    answer:
      "The search bar at the top matches an NFT's name, your own custom nickname for it, or its ID, and narrows the list as you type. The star Rating filter lives in Filters (tap Filters) - tap a star and every star up to it lights up, then tap Apply Filters to narrow the list to items rated EXACTLY that many stars (not 'that many or more'); tap the same star again, then Apply, to clear it. Both search and an already-applied star rating carry over as you switch between Devikins/Weapons/Equipment.",
  },
  {
    id: 'sort-vs-filters',
    question: "What's the difference between Sort and Filters?",
    keywords: ['sort', 'sorting', 'sort vs filter', 'sort and filter', 'order', 'difference'],
    answer:
      "Sort picks one thing to order the whole list by - tap the sort button (e.g. ID or Rarity) and pick a field, and it applies the moment you tap it, no Apply needed. It never removes anything, just changes the order everything shows up in. Filters work differently because you're usually setting up more than one at a time (say, Rarity AND Ancestry AND a star rating together) - so picking them stays separate from actually narrowing the list, which is why Filters needs its own Apply Filters tap and Sort doesn't. Filters also remembers what you last picked, so reopening it lets you add, change, or remove any of your picks - narrowing further, loosening up, or swapping one for another - without starting over. Search, Sort, and Filters all work together at once - with a big collection, combining them (say, filter to one Rarity, sort those by Ancestry, then search by name) is usually the fastest way to find one specific NFT.",
  },
  {
    id: 'devikin-filter-groups',
    question: 'Why can\'t I see all the Devikins filters at once?',
    keywords: ['genes', 'affinities', 'attributes', 'devikin filters', 'more filters', 'filter groups', 'grouped filters'],
    answer:
      "Devikins have 21 filterable traits, so on that tab Filters groups them to stay scannable: Rating, Rarity, Ancestry, Personality, Life Stage, and Procreations Left are always visible, and the rest sit inside three tappable sections - Genes, Affinities, and Attributes - each closed until you tap its name to open it. Picking a filter inside a closed section still works fine even if you leave it closed afterward; you just need to open a section once to reach the filters inside it. Weapons and Equipment aren't grouped this way yet - their filters are still one plain list.",
  },
  {
    id: 'name-rating',
    question: 'How do I give an NFT a nickname or rating?',
    keywords: ['nickname', 'rate', 'rating', 'name this', 'rename', 'stars', 'unrate', 'un-rate', 'remove rating', 'clear rating'],
    answer:
      "Open its detail view - right above the Notes section you'll find a Name field with a Save Name button, and a row of 5 stars. Type a name and tap Save Name to save it. Tap a star to rate it - once you have, a Clear Rating button appears right below the stars to un-rate it again (tapping the same star a second time does the same thing).",
  },
  {
    id: 'feedback',
    question: 'How do I send feedback or report a bug?',
    keywords: ['feedback', 'bug', 'report', 'suggest', 'contact', 'email', 'request'],
    answer:
      "Open the ☰ menu and tap Feedback. Pick a category, write your message, and tap Open Email Draft - it opens your own email app with everything already filled in. You just need to hit Send yourself.",
  },
  {
    id: 'unavailable-failed',
    question: "Why does an item say 'Unavailable' or 'Fetch failed'?",
    keywords: ['unavailable', 'missing', 'failed', 'no image', 'no data'],
    answer:
      "The game's own metadata service occasionally times out or has no data for an item yet. 'Fetch failed' items get another try the next time you tap Fetch/Update (there's no automatic background retry, so it won't fix itself on its own); 'Unavailable' means the service gave a clear 'this doesn't exist' answer, so it's treated as final and isn't retried even then.",
  },
  {
    id: 'reset-data',
    question: 'How do I reset all my data?',
    keywords: ['reset', 'wipe', 'start over', 'fresh install'],
    answer:
      "Open Wallets from the ☰ menu, scroll down to the Danger zone, and tap Reset All Data. This wipes every saved wallet, every stored NFT, and every downloaded image - back to exactly a fresh install. It can't be undone, though your real NFTs on the blockchain are never touched.",
  },
  {
    id: 'automatic-retry',
    question: 'Does the app retry failed items automatically?',
    keywords: ['automatic', 'automatically', 'background retry', 'auto retry', 'retry'],
    answer:
      "No - not any more. Everything only ever happens when you tap Fetch/Update yourself; there's no automatic background fetching or retrying. If something's stuck 'Fetch failed' or missing its image, just tap Fetch/Update again and it'll get another try.",
  },
  {
    id: 'theme-toggle',
    question: "Where's the light/dark mode button?",
    keywords: ['theme', 'dark mode', 'light mode', 'dark', 'light', 'appearance'],
    answer:
      "Next to the search bar at the very top of the screen - it shows a sun or moon icon. Tap it any time to flip between light and dark.",
  },
  {
    id: 'multiple-wallets',
    question: 'Can I add more than one wallet?',
    keywords: ['multiple wallets', 'second wallet', 'another wallet', 'two wallets', 'many wallets'],
    answer:
      "Yes - open Wallets from the ☰ menu and add as many addresses as you like. Fetch/Update pulls Devikins, Weapons, and Equipment from all of them together, and you can give each wallet its own nickname from its Edit button.",
  },
  {
    id: 'who-are-you',
    question: 'Who or what are you?',
    keywords: ['who are you', 'what are you', 'are you ai', 'are you claude', 'real ai', 'robot'],
    answer:
      "I'm Devi - a tiny, offline helper built into this app. I'm not a real AI: I can't think, I don't learn, and I only know the handful of canned answers listed here about using this app.",
  },
];

const GREETING =
  "Hi, I'm Devi! I'm a small offline helper, not a real AI - I only know a fixed set of answers about using this app. Try one of the questions below, or type your own.";

const FALLBACK_ANSWER =
  "I don't have an answer for that one - I'm just a lightweight offline helper with a fixed list of canned answers, not a real AI. Try one of the suggested questions below, or use Feedback from the ☰ menu to ask Raphael directly.";

// Lowercases and strips punctuation down to plain words separated by
// single spaces - "What's Fetch/Update do??" becomes "what s fetch
// update do", so matching below doesn't trip over apostrophes, slashes,
// or extra punctuation the way a plain substring check would.
function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Plain Levenshtein edit distance (how many single-character insertions/
// deletions/substitutions turn one word into the other) - a small,
// dependency-free way to tolerate typos like "walet" for "wallet"
// without needing any real spell-checking library. Fine for this app's
// tiny, fixed vocabulary; would be far too slow/crude for anything
// bigger.
function editDistance(a, b) {
  const table = [Array.from({ length: b.length + 1 }, (_, j) => j)];
  for (let i = 1; i <= a.length; i++) {
    table.push([i, ...Array(b.length).fill(0)]);
  }
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      table[i][j] = Math.min(
        table[i - 1][j] + 1, // deletion
        table[i][j - 1] + 1, // insertion
        table[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return table[a.length][b.length];
}

// How many typo'd characters to tolerate for a keyword of this length -
// short words need a close match (one wrong letter in a 3-4 letter word
// often changes its meaning entirely), longer ones can afford a bit more
// slack.
function maxTypoDistance(keywordLength) {
  if (keywordLength <= 4) return 0;
  if (keywordLength <= 7) return 1;
  return 2;
}

// Does one typed word count as matching a single-word keyword - exact,
// a plain prefix either direction ("wallet" typed for keyword "wallets"
// or vice versa), or close enough to count as a typo?
function wordMatchesKeyword(word, keyword) {
  if (word === keyword) return true;
  if (word.length >= 3 && keyword.startsWith(word)) return true;
  if (keyword.length >= 3 && word.startsWith(keyword)) return true;
  return editDistance(word, keyword) <= maxTypoDistance(keyword.length);
}

// Scores one FAQ entry against the typed text. A multi-word keyword
// (e.g. "star filter", "fresh install") still needs to appear as a
// substring, same as the original plain matching; a single-word keyword
// (most of them) now also counts if any typed word is a close typo or
// prefix of it, not just an exact substring - that's what lets "walet"
// or "wallting" still find the wallet answer.
function scoreEntry(entry, normalizedInput, inputWords) {
  let score = 0;
  for (const keyword of entry.keywords) {
    const normalizedKeyword = normalizeText(keyword);
    if (normalizedKeyword.includes(' ')) {
      if (normalizedInput.includes(normalizedKeyword)) score += 1;
    } else if (inputWords.some((word) => wordMatchesKeyword(word, normalizedKeyword))) {
      score += 1;
    }
  }
  return score;
}

// Finds whichever FAQ entry scores highest against the typed text (see
// scoreEntry above) - still just keyword matching, not a real language
// model, but forgiving of small typos and a bit of phrasing variation
// rather than needing an exact keyword substring. No match at all
// (score 0 everywhere) returns null, which is when FALLBACK_ANSWER is
// used.
function matchEntry(inputText) {
  const normalizedInput = normalizeText(inputText);
  const inputWords = normalizedInput.split(' ').filter(Boolean);
  let bestEntry = null;
  let bestScore = 0;

  for (const entry of FAQ_ENTRIES) {
    const score = scoreEntry(entry, normalizedInput, inputWords);
    if (score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  }

  return bestEntry;
}

let nextMessageId = 1;
function makeMessage(sender, text) {
  nextMessageId += 1;
  return { id: nextMessageId, sender, text };
}

export default function HelpAssistant({ onClose }) {
  const { colors } = useTheme();
  const [messages, setMessages] = useState(() => [makeMessage('assistant', GREETING)]);
  const [inputText, setInputText] = useState('');
  const scrollViewRef = useRef(null);
  // The chat bubbles and the always-visible FAQ list below them share
  // one long ScrollView (see the JSX comment further down). Sending a
  // question used to call scrollToEnd(), which jumps to the very
  // bottom of that whole ScrollView - i.e. past your new answer bubble
  // and all the way down to the end of the FAQ list - so the answer
  // that just appeared was scrolled straight out of view and it looked
  // like nothing had happened. Instead we measure the chat bubbles'
  // own height (messagesBlockRef's onLayout below) and the visible
  // viewport height (this ref, from the ScrollView's own onLayout),
  // and scroll only far enough to bring the newest bubble to the
  // bottom of the visible area, the way a normal chat screen does.
  const viewportHeightRef = useRef(0);

  function respondTo(questionText) {
    const trimmed = questionText.trim();
    if (!trimmed) return;

    const matchedEntry = matchEntry(trimmed);
    const answerText = matchedEntry ? matchedEntry.answer : FALLBACK_ANSWER;

    setMessages((previous) => [
      ...previous,
      makeMessage('user', trimmed),
      makeMessage('assistant', answerText),
    ]);
  }

  function handleSend() {
    respondTo(inputText);
    setInputText('');
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <TouchableOpacity
        style={[styles.backButton, { backgroundColor: colors.primary }]}
        onPress={onClose}
      >
        <Text style={[styles.backButtonText, { color: colors.primaryText }]}>‹</Text>
      </TouchableOpacity>

      <Text style={[styles.title, { color: colors.text }]}>Devi</Text>
      <Text style={[styles.subtitle, { color: colors.secondaryText }]}>
        An offline in-app helper - not a real AI, just a fixed list of answers about using this app.
      </Text>

      <KeyboardAvoidingView
        style={styles.flexOne}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          ref={scrollViewRef}
          style={styles.chatLog}
          contentContainerStyle={styles.chatLogContent}
          onLayout={(event) => {
            viewportHeightRef.current = event.nativeEvent.layout.height;
          }}
        >
          <View
            onLayout={(event) => {
              // Fires whenever the chat bubbles' own total height
              // changes - i.e. whenever a message is added - with the
              // FAQ list below excluded, since it's a sibling, not part
              // of this measured View. Skip the very first render
              // (just the greeting) so opening the screen doesn't
              // scroll anywhere on its own.
              if (messages.length <= 1) return;
              const messagesHeight = event.nativeEvent.layout.height;
              const targetY = Math.max(0, messagesHeight - viewportHeightRef.current + 24);
              scrollViewRef.current?.scrollTo({ y: targetY, animated: true });
            }}
          >
            {messages.map((message) => {
            const isUser = message.sender === 'user';
            return (
              <View
                key={message.id}
                style={[styles.bubbleRow, isUser ? styles.bubbleRowUser : styles.bubbleRowAssistant]}
              >
                <View
                  style={[
                    styles.bubble,
                    { backgroundColor: isUser ? colors.primary : colors.surfaceAlt, borderColor: colors.border },
                  ]}
                >
                  <Text style={[styles.bubbleText, { color: isUser ? colors.primaryText : colors.text }]}>
                    {message.text}
                  </Text>
                </View>
              </View>
            );
          })}
          </View>

          {/* The full FAQ, always visible - every question with its
              answer listed directly underneath it, one after another,
              rather than behind tappable chips you'd have to try one at
              a time to see what's there. Typing your own question below
              still works and appends its own answer as a chat bubble
              above this list. */}
          <View style={[styles.faqSection, { borderTopColor: colors.border }]}>
            <Text style={[styles.faqSectionTitle, { color: colors.secondaryText }]}>
              Frequently asked
            </Text>
            {FAQ_ENTRIES.map((entry) => (
              <View key={entry.id} style={styles.faqEntry}>
                <Text style={[styles.faqQuestion, { color: colors.primary }]}>{entry.question}</Text>
                <Text style={[styles.faqAnswer, { color: colors.text }]}>{entry.answer}</Text>
              </View>
            ))}
          </View>
        </ScrollView>

        <View style={styles.inputRow}>
          <TextInput
            style={[styles.textInput, { backgroundColor: colors.surfaceAlt, borderColor: colors.border, color: colors.text }]}
            placeholder="Ask Devi something..."
            placeholderTextColor={colors.secondaryText}
            value={inputText}
            onChangeText={setInputText}
            onSubmitEditing={handleSend}
            returnKeyType="send"
          />
          <TouchableOpacity
            style={[
              styles.sendButton,
              { backgroundColor: colors.primary },
              inputText.trim().length === 0 && { backgroundColor: colors.primaryDisabled },
            ]}
            onPress={handleSend}
            disabled={inputText.trim().length === 0}
          >
            <Text style={[styles.sendButtonText, { color: colors.primaryText }]}>Send</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  flexOne: {
    flex: 1,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    marginHorizontal: 12,
    marginVertical: 12,
    alignSelf: 'flex-start',
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButtonText: {
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 24,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    marginHorizontal: 12,
  },
  subtitle: {
    fontSize: 13,
    marginHorizontal: 12,
    marginTop: 4,
    marginBottom: 12,
  },
  chatLog: {
    flex: 1,
  },
  chatLogContent: {
    paddingHorizontal: 12,
    paddingBottom: 12,
    gap: 10,
  },
  bubbleRow: {
    flexDirection: 'row',
  },
  bubbleRowUser: {
    justifyContent: 'flex-end',
  },
  bubbleRowAssistant: {
    justifyContent: 'flex-start',
  },
  bubble: {
    maxWidth: '82%',
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  bubbleText: {
    fontSize: 14,
    lineHeight: 20,
  },
  // The always-visible FAQ list - see the JSX comment above. Sits
  // inside the same scrollable area as the chat bubbles, set off by its
  // own top border and a small muted section title.
  faqSection: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
  },
  faqSectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  faqEntry: {
    marginBottom: 16,
  },
  faqQuestion: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 4,
  },
  faqAnswer: {
    fontSize: 13,
    lineHeight: 19,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  textInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  sendButton: {
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sendButtonText: {
    fontWeight: '600',
  },
});
