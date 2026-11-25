/**
 * UpdateNote.js - "New version available - Update" (website, 25 Nov 2026)
 *
 * Shown at the bottom of the screen when the installable website has
 * prepared a new version in the background (src/web/pwa.js). Tapping
 * Update switches to it and reloads the page once; "Later" hides the note
 * until the Hub is opened again (the new version then still waits).
 * Nothing shows in the Android app.
 */
import React, { useState } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { applyUpdate, useUpdateReady } from '../web/pwa';

export default function UpdateNote() {
  const { colors } = useTheme();
  const ready = useUpdateReady();
  const [later, setLater] = useState(false);
  if (Platform.OS !== 'web' || !ready || later) return null;
  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <View style={[styles.note, { backgroundColor: colors.surface, borderColor: colors.primary }]} testID="update-note">
        <Text style={[styles.text, { color: colors.text }]}>A new version of the Hub is available.</Text>
        <TouchableOpacity onPress={() => setLater(true)} style={styles.later} accessibilityRole="button" testID="update-later">
          <Text style={[styles.laterText, { color: colors.secondaryText }]}>Later</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={applyUpdate} style={[styles.button, { backgroundColor: colors.primary }]} accessibilityRole="button" testID="update-now">
          <Text style={[styles.buttonText, { color: colors.primaryText }]}>Update</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, bottom: 16, alignItems: 'center', paddingHorizontal: 12 },
  note: {
    flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12,
    paddingVertical: 8, paddingHorizontal: 12, maxWidth: 520, width: '100%',
  },
  text: { flex: 1, fontSize: 14 },
  later: { paddingVertical: 6, paddingHorizontal: 8 },
  laterText: { fontSize: 14, fontWeight: '600' },
  button: { paddingVertical: 7, paddingHorizontal: 14, borderRadius: 8 },
  buttonText: { fontSize: 14, fontWeight: '700' },
});
