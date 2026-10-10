/**
 * AboutView.js
 *
 * The "About" screen: which version of the Hub this is, how many people
 * use it (the anonymous counter - see src/api/usage.js), a short privacy
 * note with a "count me" switch, and a few links.
 */

import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Linking, Switch, ScrollView, ActivityIndicator } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { fetchUsageStats, isUsageOptedOut, setUsageOptOut } from '../api/usage';

const WEBSITE_URL = 'https://raphaelrohner.github.io/devikins-legacy-hub/';
const SOURCE_URL = 'https://github.com/RaphaelRohner/devikins-legacy-hub';

const PLATFORM_LABEL = { web: 'Website', android: 'Android app', ios: 'iPhone app' };

export default function AboutView({ appVersion, onClose }) {
  const { colors } = useTheme();
  const [stats, setStats] = useState(undefined); // undefined = loading, null = unavailable
  const [countMe, setCountMe] = useState(true);

  useEffect(() => {
    let alive = true;
    fetchUsageStats().then((s) => alive && setStats(s));
    isUsageOptedOut().then((out) => alive && setCountMe(!out));
    return () => {
      alive = false;
    };
  }, []);

  async function toggleCountMe(value) {
    setCountMe(value);
    await setUsageOptOut(!value);
  }

  const byPlatform = stats?.last30DaysByPlatform || {};
  const platformLine = ['web', 'android', 'ios']
    .filter((p) => byPlatform[p])
    .map((p) => `${PLATFORM_LABEL[p]}: ${byPlatform[p]}`)
    .join(' · ');

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.topRow}>
        <TouchableOpacity style={[styles.backButton, { backgroundColor: colors.primary }]} onPress={onClose}>
          <Text style={[styles.backButtonText, { color: colors.primaryText }]}>‹</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.text }]}>About</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.heading, { color: colors.text }]}>Devi Hub</Text>
          <Text style={[styles.text, { color: colors.text }]}>
            Version {appVersion} · {PLATFORM_LABEL[Platform.OS] || Platform.OS}
          </Text>
          <Text style={[styles.note, { color: colors.secondaryText }]}>
            A free companion for Devikins collectors. Made by Raphael, with lots of help from Claude. A personal
            project, not affiliated with or endorsed by Moonlabs or Klever.
          </Text>
        </View>

        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.heading, { color: colors.text }]}>Users</Text>
          {stats === undefined ? (
            <ActivityIndicator color={colors.primary} />
          ) : stats === null ? (
            <Text style={[styles.note, { color: colors.secondaryText }]}>The user count can't be loaded right now.</Text>
          ) : (
            <>
              <View style={styles.statRow}>
                <Stat label="Last 30 days" value={stats.last30Days} colors={colors} />
                <Stat label="Today" value={stats.today} colors={colors} />
                <Stat label="Since launch" value={stats.total} colors={colors} />
              </View>
              {platformLine ? (
                <Text style={[styles.note, { color: colors.secondaryText }]}>Last 30 days: {platformLine}</Text>
              ) : null}
            </>
          )}
        </View>

        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.heading, { color: colors.text }]}>Privacy</Text>
          <Text style={[styles.note, { color: colors.secondaryText }]}>
            Your wallets, NFTs, names and stars stay on this device. For the user count, the Hub sends a random
            ID (not linked to you or your wallets) at most once a day, together with "website/app" and the
            version. Nothing else is sent.
          </Text>
          <View style={styles.switchRow}>
            <Text style={[styles.text, { color: colors.text, flex: 1 }]}>Count me (anonymously)</Text>
            <Switch value={countMe} onValueChange={toggleCountMe} />
          </View>
        </View>

        <View style={styles.buttonRow}>
          {Platform.OS !== 'web' ? (
            <TouchableOpacity style={[styles.button, { backgroundColor: colors.primary }]} onPress={() => Linking.openURL(WEBSITE_URL)}>
              <Text style={[styles.buttonText, { color: colors.primaryText }]}>Open the website</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={[styles.button, { backgroundColor: colors.primary }]} onPress={() => Linking.openURL(SOURCE_URL)}>
            <Text style={[styles.buttonText, { color: colors.primaryText }]}>Source code on GitHub</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

function Stat({ label, value, colors }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color: colors.text }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.secondaryText }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topRow: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 12, marginVertical: 12, gap: 8 },
  backButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  backButtonText: { fontSize: 22, fontWeight: '700', lineHeight: 24 },
  title: { flex: 1, fontSize: 18, fontWeight: '700' },
  content: { paddingHorizontal: 12, paddingBottom: 24, gap: 12, maxWidth: 640, width: '100%' },
  card: { padding: 16, borderRadius: 12, borderWidth: 1, gap: 8 },
  heading: { fontSize: 16, fontWeight: '700' },
  text: { fontSize: 15, lineHeight: 21 },
  note: { fontSize: 13, lineHeight: 18 },
  statRow: { flexDirection: 'row', gap: 12 },
  stat: { flex: 1, alignItems: 'center', paddingVertical: 6 },
  statValue: { fontSize: 24, fontWeight: '700' },
  statLabel: { fontSize: 12 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  button: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8 },
  buttonText: { fontSize: 15, fontWeight: '700' },
});
