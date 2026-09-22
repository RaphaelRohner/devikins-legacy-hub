/**
 * Feedback.js
 *
 * The "Feedback" screen, opened from the hamburger menu (see
 * HamburgerMenu.js's sixth entry). Lets the user send feature requests,
 * bug reports, or general feedback without the app needing its own
 * backend or email-sending service - it just builds a normal mailto:
 * link and hands it to the phone's own email app via Linking.openURL().
 * The player still has to actually tap Send themselves in whatever
 * email app opens - this app never sends anything on its own. The body
 * is pre-filled in a fixed order, per feedback: the app name and
 * version, the sender's own email address (if given, so Raphael can
 * reply), the feedback type, the name (if given), then the message
 * itself - see handleSubmit below.
 *
 * Why mailto: and not a "send to GitHub" address: GitHub's own
 * commit-attribution noreply addresses (id+username@users.noreply.
 * github.com) are outbound-only - they don't receive or forward inbound
 * email from anyone else, so there's no way to make "email GitHub and
 * have it land in my inbox" actually work.
 *
 * FEEDBACK_EMAIL below used to be a "+" alias of Raphael's own primary
 * Gmail address (mail to you+anything@gmail.com lands straight in
 * your normal inbox - no separate mailbox needed), which worked fine,
 * but per feedback he'd rather keep his real personal contact out of
 * the app's source as much as possible - a public-ish repo is no place
 * for it, even tagged. Switched to a separate address he already owns
 * from an older game project instead, so this app's source never
 * contains his primary email at all.
 *
 * Like every other "screen" in this app (see App.js's own file comment),
 * this is a plain component App.js swaps in based on `currentScreen`,
 * with its own small round "‹" back button in the top-left corner (the
 * same icon-only pattern used by WalletManager.js, CollectionView.js's
 * detail view, and HelpAssistant.js - all four used to say "‹ Back to
 * Home" in full, shortened to just the arrow per feedback).
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
import { Picker } from '@react-native-picker/picker';
import { useTheme } from '../context/ThemeContext';

// A separate Gmail address Raphael already owns from an older game
// project - not his primary personal address - so this app's source
// never has to contain that one. See this file's own header comment
// for why this changed from a "+" alias of his primary address.
const FEEDBACK_EMAIL = 'chibitales2@gmail.com';

const APP_NAME = 'Devikins Legacy Companion';

// The three feedback categories - a name key/store id (used internally
// and in the email body) and a friendlier label. Shown as a dropdown
// Picker, same pattern as FilterPanel.js elsewhere in the app.
const CATEGORIES = [
  { key: 'feature', label: 'Feature request' },
  { key: 'bug', label: 'Bug report' },
  { key: 'feedback', label: 'Feedback' },
];

export default function Feedback({ appVersion, onClose }) {
  const { colors } = useTheme();

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('feedback');
  const [message, setMessage] = useState('');

  const canSubmit = message.trim().length > 0;

  async function handleSubmit() {
    const categoryLabel = CATEGORIES.find((c) => c.key === category)?.label ?? 'Feedback';
    const subject = `${APP_NAME} v${appVersion} - ${categoryLabel}`;
    // Fixed order per feedback: the app name and version, the sender's
    // own email address (so Raphael has a way to reply - this is NOT
    // the address the draft is sent to, see FEEDBACK_EMAIL/mailtoUrl
    // below for that), the feedback type, the name (if given), then
    // the message itself.
    const body =
      `App: ${APP_NAME} v${appVersion}\n` +
      `Email: ${email.trim() || '(not provided)'}\n` +
      `Feedback type: ${categoryLabel}\n` +
      `Name: ${name.trim() || '(not provided)'}\n\n` +
      `Message:\n${message.trim()}`;

    const mailtoUrl = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

    try {
      // We used to guard this with Linking.canOpenURL() first, but on a
      // real (non-Expo-Go) Android build that check comes back false
      // even when an email app is installed - Android 11+ restricts
      // which other apps yours can "see" unless it explicitly declares
      // that ahead of time, and canOpenURL's visibility check is
      // exactly what that restriction blocks. openURL() itself doesn't
      // hit that restriction, so we just try it directly and let the
      // catch below handle a genuine failure (no email app at all).
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
        <Text style={[styles.backButtonText, { color: colors.primaryText }]}>‹</Text>
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
          <Text style={[styles.fieldLabel, { color: colors.text }]}>Your email (optional, so we can reply)</Text>
          <TextInput
            style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
            placeholder="you@example.com"
            placeholderTextColor={colors.secondaryText}
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={[styles.fieldLabel, { color: colors.text }]}>What kind of feedback is this?</Text>
          <View style={[styles.pickerWrapper, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Picker
              selectedValue={category}
              onValueChange={setCategory}
              style={{ color: colors.text }}
              dropdownIconColor={colors.text}
            >
              {CATEGORIES.map((entry) => (
                <Picker.Item key={entry.key} label={entry.label} value={entry.key} />
              ))}
            </Picker>
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
  pickerWrapper: {
    borderWidth: 1,
    borderRadius: 8,
    marginBottom: 20,
    overflow: 'hidden',
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
