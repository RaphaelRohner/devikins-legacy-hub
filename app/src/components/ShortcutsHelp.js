/**
 * ShortcutsHelp.js - the box that lists the keyboard shortcuts (press ? on
 * the website, or "Keyboard shortcuts" at the bottom of the ☰ menu). See
 * src/web/shortcuts.js.
 */
import { useEffect, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { SHORTCUTS, IS_WEB, setShortcutsHelpOpener } from '../web/shortcuts';

export default function ShortcutsHelp() {
  const { colors } = useTheme();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    setShortcutsHelpOpener(() => setVisible(true));
    return () => setShortcutsHelpOpener(null);
  }, []);
  if (!IS_WEB) return null;
  const keyBox = (text) => (
    <Text style={[styles.key, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}>{text}</Text>
  );
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]} testID="shortcuts-help">
          <Text style={[styles.title, { color: colors.text }]}>Keyboard shortcuts</Text>
          <Text style={[styles.note, { color: colors.secondaryText }]}>Press G, then the letter - plain small letters, no Shift (keyboards print their keys in capitals, so the list does too). They don't work while you're typing in a text box.</Text>
          {SHORTCUTS.map((s) => (
            <View key={s.key} style={styles.row}>
              <View style={styles.keys}>
                {keyBox('G')}
                {keyBox(s.key.toUpperCase())}
              </View>
              <Text style={[styles.text, { color: colors.text }]}>{s.label}</Text>
            </View>
          ))}
          <View style={styles.row}>
            <View style={styles.keys}>{keyBox('?')}</View>
            <Text style={[styles.text, { color: colors.text }]}>This list</Text>
          </View>
          <TouchableOpacity style={[styles.button, { backgroundColor: colors.primary }]} onPress={() => setVisible(false)} testID="shortcuts-help-close">
            <Text style={[styles.buttonText, { color: colors.primaryText }]}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: 16 },
  card: { width: '100%', maxWidth: 420, borderWidth: 1, borderRadius: 14, padding: 16, gap: 8 },
  title: { fontSize: 18, fontWeight: '700' },
  note: { fontSize: 13, lineHeight: 18, marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  keys: { flexDirection: 'row', gap: 4, width: 64 },
  key: { minWidth: 26, textAlign: 'center', borderWidth: 1, borderRadius: 6, paddingVertical: 2, paddingHorizontal: 6, fontSize: 13, fontWeight: '700' },
  text: { fontSize: 15 },
  button: { marginTop: 8, paddingVertical: 10, borderRadius: 8, alignItems: 'center' },
  buttonText: { fontSize: 15, fontWeight: '700' },
});
