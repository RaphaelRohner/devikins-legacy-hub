/**
 * ChatBackupPasswordBox.js — the password box for the chat part of a backup
 *
 * Shown by WalletManager.js (website):
 *   - 'export': "Export all sets" while there's a chat in this browser:
 *     choose a password (twice) to include the chat, or leave it out;
 *   - 'import': the backup holds a chat: type its password to bring the
 *     chat back, or skip.
 * The locking itself is in app/chat/src/backup.js.
 */

import { useEffect, useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { MIN_PASSWORD_LENGTH } from '../api/chatBackup';
import { useWebKeyboardRoom } from '../web/keyboardRoom';

/** The answer for "✕ Cancel" (28 Oct 2026, Raphael: the box had no way out): no export at all / skip the chat on import. */
export const CANCELLED = 'cancelled';

export default function ChatBackupPasswordBox({ ask, onAnswer }) {
  const { colors } = useTheme();
  // (the website on a phone: above the keyboard too - src/web/keyboardRoom.js, 28 Oct 2026)
  const keyboardRoom = useWebKeyboardRoom();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [problem, setProblem] = useState('');

  useEffect(() => {
    setPassword('');
    setRepeat('');
    setProblem(ask?.error || '');
  }, [ask]);

  if (!ask) return null;
  const isExport = ask.mode === 'export';

  function submit() {
    if (isExport) {
      if (password.length < MIN_PASSWORD_LENGTH) {
        setProblem(`The password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
        return;
      }
      if (password !== repeat) {
        setProblem("The two passwords aren't the same.");
        return;
      }
    } else if (!password) {
      return;
    }
    onAnswer(password);
  }

  const input = (value, onChange, placeholder, testID, last) => (
    <TextInput
      testID={testID}
      style={[styles.input, { backgroundColor: colors.background, borderColor: colors.border, color: colors.text }]}
      value={value}
      onChangeText={(t) => {
        onChange(t);
        setProblem('');
      }}
      placeholder={placeholder}
      placeholderTextColor={colors.secondaryText}
      secureTextEntry
      autoComplete={isExport ? 'new-password' : 'current-password'}
      onSubmitEditing={last ? submit : undefined}
    />
  );

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => onAnswer(CANCELLED)}>
      {/* (moves up with the keyboard on phones, 26 Oct 2026) */}
      <KeyboardAvoidingView style={[styles.backdrop, keyboardRoom ? { paddingBottom: keyboardRoom } : null]} behavior={Platform.OS === 'web' ? undefined : 'padding'}>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]} testID="chat-backup-box">
          <View style={styles.titleRow}>
            <Text style={[styles.title, { color: colors.text, flex: 1 }]}>{isExport ? 'Include your chat?' : 'Bring your chat back?'}</Text>
            <TouchableOpacity
              onPress={() => onAnswer(CANCELLED)}
              accessibilityLabel={isExport ? 'Cancel the backup' : 'Close'}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              testID="chat-backup-cancel"
            >
              <Text style={[styles.close, { color: colors.primary }]}>✕</Text>
            </TouchableOpacity>
          </View>
          <Text style={[styles.text, { color: colors.text }]}>
            {isExport
              ? 'This backup can also hold your chat (your chat key, contacts and messages), locked with a password you choose now.'
              : 'This backup contains a chat, locked with a password. Type it to bring the chat back in this browser.'}
          </Text>
          <Text style={[styles.note, { color: colors.secondaryText }]}>
            {isExport
              ? 'Without the password nobody can open the chat part, and a forgotten password can\'t be recovered. Your wallet sets in the backup aren\'t affected by it.'
              : 'Use the chat in one browser at a time: the other browser stops getting new messages once this one collects them.'}
          </Text>
          {input(password, setPassword, 'Password', 'chat-backup-password', !isExport)}
          {isExport ? input(repeat, setRepeat, 'Repeat the password', 'chat-backup-repeat', true) : null}
          {problem ? <Text style={[styles.note, { color: colors.cancelText }]} testID="chat-backup-problem">{problem}</Text> : null}
          <TouchableOpacity style={[styles.button, { backgroundColor: colors.primary }]} onPress={submit} testID="chat-backup-ok">
            <Text style={[styles.buttonText, { color: colors.primaryText }]}>{isExport ? 'Back up with the chat' : 'Bring the chat back'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.skip} onPress={() => onAnswer(null)} testID="chat-backup-skip">
            <Text style={[styles.skipText, { color: colors.secondaryText }]}>{isExport ? 'Back up without the chat' : 'Skip the chat'}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: 16 },
  card: { width: '100%', maxWidth: 440, borderWidth: 1, borderRadius: 14, padding: 16, gap: 10 },
  title: { fontSize: 18, fontWeight: '700' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  close: { fontSize: 20, fontWeight: '700' },
  text: { fontSize: 15, lineHeight: 21 },
  note: { fontSize: 13, lineHeight: 18 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9, fontSize: 15 },
  button: { paddingVertical: 10, borderRadius: 8, alignItems: 'center' },
  buttonText: { fontSize: 15, fontWeight: '700' },
  skip: { alignSelf: 'center', paddingVertical: 6, paddingHorizontal: 16 },
  skipText: { fontSize: 14, fontWeight: '600' },
});
