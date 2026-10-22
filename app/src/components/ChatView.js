/**
 * ChatView.js — phone version of the Chat screen.
 *
 * The chat starts on the website (ChatView.web.js); the phone app gets it
 * in a later stage (linked devices, push notifications). Until then the
 * menu doesn't show the Chat entry on the phone, and this placeholder
 * keeps the chat code out of the phone app.
 */

import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme } from '../context/ThemeContext';

export default function ChatView({ onClose }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <TouchableOpacity style={[styles.backButton, { backgroundColor: colors.primary }]} onPress={onClose}>
        <Text style={[styles.backButtonText, { color: colors.primaryText }]}>‹</Text>
      </TouchableOpacity>
      <Text style={[styles.text, { color: colors.text }]}>The chat is on the Hub website for now; the app gets it later.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 12, gap: 12 },
  backButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  backButtonText: { fontSize: 22, fontWeight: '700', lineHeight: 24 },
  text: { fontSize: 15 },
});
