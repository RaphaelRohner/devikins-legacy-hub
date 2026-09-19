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
 * that costs money or needs a backend - just plain keyword matching
 * against FAQ_ENTRIES below. A real AI chat (calling an actual LLM API)
 * would need a backend server to hold the API key safely and would cost
 * real money per message - a much bigger project than this.
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
 * from the hamburger menu, with its own "‹ Back to Home" button.
 */

import { useEffect, useRef, useState } from 'react';
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
    keywords: ['wallet', 'address', 'klv1'],
    answer:
      "Open the ☰ menu and tap Wallets. Paste your Klever wallet address (starts with klv1...) and tap Add. You can add as many wallets as you like, and give each one a nickname from its Edit button.",
  },
  {
    id: 'fetch-update',
    question: 'What does Fetch/Update do?',
    keywords: ['fetch', 'update', 'scan', 'refresh', 'sync'],
    answer:
      "It asks the Klever blockchain which Devikins, Weapons, and Equipment your wallet(s) hold, then downloads each one's details and picture. The first fetch takes the longest since nothing's cached yet - after that, it's much faster, and it also retries anything that failed automatically in the background.",
  },
  {
    id: 'deleted',
    question: "What does marking something 'Deleted' do?",
    keywords: ['delete', 'deleted', 'hide', 'sold', 'restore'],
    answer:
      "It's a personal organizing flag only - nothing is removed from the blockchain, or even from this app's own database. It greys the item out (or hides it entirely if you switch on the Deleted filter) so your list stays tidy, and you can tap Restore on it any time. One thing to know: if you still hold the NFT, the next Fetch/Update will automatically un-delete it, since successfully re-fetching it is proof you still own it.",
  },
  {
    id: 'list-tiles',
    question: "What's the difference between List and Tiles view?",
    keywords: ['list', 'tiles', 'grid', 'view'],
    answer:
      "List shows a picture plus a few key stats for each item; Tiles shows a compact grid of just the pictures, so you can scan a big collection faster. Each of Devikins/Weapons/Equipment remembers its own choice.",
  },
  {
    id: 'search-star-filter',
    question: 'How do search and the star filter work?',
    keywords: ['search', 'star filter', 'filter'],
    answer:
      "The search bar at the top matches an NFT's name, your own custom nickname for it, or its ID. Tapping one of the five stars next to it shows only items rated EXACTLY that many stars (not 'that many or more') - tap the same star again to clear it. Both carry over as you switch between Devikins/Weapons/Equipment.",
  },
  {
    id: 'name-rating',
    question: 'How do I give an NFT a nickname or rating?',
    keywords: ['nickname', 'rate', 'rating', 'name this'],
    answer:
      "Open its detail view - right above the Notes section you'll find a Name field and a row of 5 stars. Type a name and tap away from the field to save it; tap a star to rate it, or tap that same star again to clear the rating.",
  },
  {
    id: 'feedback',
    question: 'How do I send feedback or report a bug?',
    keywords: ['feedback', 'bug', 'report', 'suggest', 'contact'],
    answer:
      "Open the ☰ menu and tap Feedback. Pick a category, write your message, and tap Open Email Draft - it opens your own email app with everything already filled in. You just need to hit Send yourself.",
  },
  {
    id: 'unavailable-failed',
    question: "Why does an item say 'Unavailable' or 'Fetch failed'?",
    keywords: ['unavailable', 'missing', 'failed', 'no image', 'no data'],
    answer:
      "The game's own metadata service occasionally times out or has no data for an item yet. 'Fetch failed' items get retried automatically in the background (and again on your next Fetch/Update); 'Unavailable' means the service gave a clear 'this doesn't exist' answer, so it's treated as final and isn't retried.",
  },
  {
    id: 'reset-data',
    question: 'How do I reset all my data?',
    keywords: ['reset', 'wipe', 'start over', 'fresh install'],
    answer:
      "Open Wallets from the ☰ menu, scroll down to the Danger zone, and tap Reset All Data. This wipes every saved wallet, every stored NFT, and every downloaded image - back to exactly a fresh install. It can't be undone, though your real NFTs on the blockchain are never touched.",
  },
  {
    id: 'who-are-you',
    question: 'Who or what are you?',
    keywords: ['who are you', 'what are you', 'are you ai', 'are you claude', 'real ai', 'robot'],
    answer:
      "I'm Devi - a tiny, offline helper built into this app. I'm not a real AI: I can't think, I don't learn, and I only know the handful of canned answers listed here about using this app. (Fittingly, I exist because Raphael asked the real Claude, only half-joking, to build \"a downgraded version of you\" into the app.)",
  },
];

const GREETING =
  "Hi, I'm Devi! I'm a small offline helper, not a real AI - I only know a fixed set of answers about using this app. Try one of the questions below, or type your own.";

const FALLBACK_ANSWER =
  "I don't have an answer for that one - I'm just a lightweight offline helper with a fixed list of canned answers, not a real AI. Try one of the suggested questions below, or use Feedback from the ☰ menu to ask Raphael directly.";

// Very simple keyword matching: score every FAQ entry by how many of its
// keywords appear anywhere in the typed text (case-insensitive,
// substring match - good enough for a small, fixed list like this), and
// return whichever entry scores highest. No match at all (score 0
// everywhere) returns null, which is when FALLBACK_ANSWER is used.
function matchEntry(inputText) {
  const normalized = inputText.toLowerCase();
  let bestEntry = null;
  let bestScore = 0;

  for (const entry of FAQ_ENTRIES) {
    let score = 0;
    for (const keyword of entry.keywords) {
      if (normalized.includes(keyword)) {
        score += 1;
      }
    }
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

  // Keeps the chat scrolled to the newest message, the same way any
  // normal chat/messaging screen behaves.
  useEffect(() => {
    scrollViewRef.current?.scrollToEnd({ animated: true });
  }, [messages]);

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
        <Text style={[styles.backButtonText, { color: colors.primaryText }]}>‹ Back to Home</Text>
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
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    marginHorizontal: 12,
    marginVertical: 12,
    alignSelf: 'flex-start',
  },
  backButtonText: {
    fontSize: 15,
    fontWeight: '600',
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
