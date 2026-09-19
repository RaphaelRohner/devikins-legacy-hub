/**
 * Feedback.js
 *
 * The "Feedback" screen, opened from the hamburger menu (see
 * HamburgerMenu.js's sixth entry). Lets the user send feature requests,
 * bug reports, or general feedback without the app needing its own
 * backend or email-sending service - it just builds a normal mailto:
 * link (App name/version, category, name, and the free-text message all
 * pre-filled into the subject/body) and hands it to the phone's own
 * email app via Linking.openURL(). The player still has to actually tap
 * Send themselves in whatever email app opens - this app never sends
 * anything on its own.
 *
 * Why mailto: and not a "send to GitHub" address: GitHub's own
 * commit-attribution noreply addresses (id+username@users.noreply.
 * github.com) are outbound-only - they don't receive or forward inbound
 * email from anyone else, so there's no way to make "email GitHub and
 * have it land in my inbox" actually work. A "+" alias of Raphael's own
 * address (see FEEDBACK_EMAIL below) is a real inbox that also makes
 * feedback easy to filter/label, without needing any new infrastructure.
 *
 * Like every other "screen" in this app (see App.js's own file comment),
 * this is a plain component App.js swaps in based on `currentScreen`,
 * with its own "‹ Back to Home" button - same pattern WalletManager.js
 * uses.
 */

import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Linking,
  Alert,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';

// A "+" alias of Raphael's own Gmail address - mail sent here lands in
// his normal inbox (Gmail treats anything before the "+" as the real
// address), just easy to filter/label separately from everything else,
// without needing a dedicated support inbox or any new infrastructure.
const FEEDBACK_EMAIL = '[old feedback address removed]';

const APP_NAME = 'Devikins Legacy Companion';

// The three feedback categories - a name key/store id (used internally
// and in the email body) and a friendlier label. Plain buttons rather
// than a dropdown Picker (like FilterPanel.js uses elsewhere) since
// there are only three, fixed, always-visible options - a row of
// buttons is both quicker to pick from and doesn't need scrolling.
const CATEGORIES = [
  { key: 'feature', label: 'Feature request' },
  { key: 'bug', label: 'Bug report' },
  { key: 'feedback', label: 'Feedback' },
];

export default function Feedback({ appVersion, onClose }) {
  const { colors } = useTheme();

  const [name, setName] = useState('');
  const [category, setCategory] = useState('feedback');
  const [message, setMessage] = useState('');

  const canSubmit = message.trim().length > 0;

  async function handleSubmit() {
    const categoryLabel = CATEGORIES.find((c) => c.key === category)?.label ?? 'Feedback';
    const subject = `${APP_NAME} - ${categoryLabel}`;
    const body =
      `App: ${APP_NAME} v${appVersion}\n` +
      `Category: ${categoryLabel}\n` +
      `Name: ${name.trim() || '(not provided)'}\n\n` +
      `${message.trim()}`;

    const mailtoUrl = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

    try {
      const canOpen = await Linking.canOpenURL(mailtoUrl);
      if (!canOpen) {
        throw new Error('No email app available');
      }
      await Linking.openURL(mailtoUrl);
    } catch (err) {
      Alert.alert(
        "Couldn't open your email app",
        `Please email ${FEEDBACK_EMAIL} directly instead - your message:\n\n${body}`
      );
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <TouchableOpacity
        style={[styles.backButton, { backgroundColor: colors.primary }]}
        onPress={onClose}
      >
        <Text style={[styles.backButtonText, { color: colors.primaryText }]}>‹ Back to Home</Text>
      </TouchableOpacity>

      <Text style={[styles.title, { color: colors.text }]}>Feedback</Text>
      <Text style={[styles.subtitle, { color: colors.secondaryText }]}>
        This opens your own email app with a pre-filled draft to {FEEDBACK_EMAIL} - you'll still need to tap Send yourself once it's open.
      </Text>

      <KeyboardAvoidingView
        style={styles.flexOne}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.formContent}>
          <Text style={[styles.fieldLabel, { color: colors.text }]}>What kind of feedback is this?</Text>
          <View style={styles.categoryRow}>
            {CATEGORIES.map((entry) => {
              const isSelected = category === entry.key;
              return (
                <TouchableOpacity
                  key={entry.key}
                  style={[
                    styles.categoryButton,
                    { backgroundColor: colors.surface, borderColor: colors.border },
                    isSelected && { borderColor: colors.primary, backgroundColor: colors.chipBackground },
                  ]}
                  onPress={() => setCategory(entry.key)}
                >
                  <Text style={[styles.categoryButtonText, { color: isSelected ? colors.primary : colors.text }]}>
                    {entry.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={[styles.fieldLabel, { color: colors.text }]}>Your name (optional)</Text>
          <TextInput
            style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
            placeholder="Name"
            placeholderTextColor={colors.secondaryText}
            value={name}
            onChangeText={setName}
          />

          <Text style={[styles.fieldLabel, { color: colors.text }]}>Message</Text>
          <TextInput
            style={[styles.input, styles.messageInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
            placeholder="What's on your mind?"
            placeholderTextColor={colors.secondaryText}
            value={message}
            onChangeText={setMessage}
            multiline
          />

          <TouchableOpacity
            style={[
              styles.submitButton,
              { backgroundColor: colors.primary },
              !canSubmit && { backgroundColor: colors.primaryDisabled },
            ]}
            onPress={handleSubmit}
            disabled={!canSubmit}
          >
            <Text style={[styles.submitButtonText, { color: colors.primaryText }]}>Open Email Draft</Text>
          </TouchableOpacity>
        </ScrollView>
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
    marginBottom: 16,
  },
  formContent: {
    padding: 12,
    paddingBottom: 24,
  },
  fieldLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  categoryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 20,
  },
  categoryButton: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  categoryButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    marginBottom: 20,
  },
  messageInput: {
    minHeight: 140,
    textAlignVertical: 'top',
  },
  submitButton: {
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  submitButtonText: {
    fontWeight: '600',
  },
});
