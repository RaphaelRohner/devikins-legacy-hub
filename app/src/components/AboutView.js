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

// The columns of the Users table; keys match the relay's /stats answer.
const PERIODS = [
  { key: 'today', label: 'Today' },
  { key: 'last7Days', label: '7 days' },
  { key: 'last30Days', label: '30 days' },
  { key: 'total', label: 'Since launch' },
];

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
                <Text style={styles.rowLabel} />
                {PERIODS.map((p) => (
                  <Text key={p.key} style={[styles.statLabel, styles.statCell, { color: colors.secondaryText }]}>
                    {p.label}
                  </Text>
                ))}
              </View>
              <View style={styles.statRow}>
                <Text style={[styles.rowLabel, { color: colors.text }]}>Hubs</Text>
                {PERIODS.map((p) => (
                  <Text key={p.key} style={[styles.statValue, styles.statCell, { color: colors.text }]}>
                    {stats[p.key] ?? '–'}
                  </Text>
                ))}
              </View>
              {stats.visits ? (
                <View style={styles.statRow}>
                  <Text style={[styles.rowLabel, { color: colors.text }]}>Visits</Text>
                  {PERIODS.map((p) => (
                    <Text key={p.key} style={[styles.statValue, styles.statCell, { color: colors.text }]}>
                      {stats.visits[p.key] ?? '–'}
                    </Text>
                  ))}
                </View>
              ) : null}
              {platformLine ? (
                <Text style={[styles.note, { color: colors.secondaryText }]}>Hubs in the last 30 days: {platformLine}</Text>
              ) : null}
              <Text style={[styles.note, { color: colors.secondaryText }]}>
                Hubs: how many different Hubs were used - one used every day this week counts once in "7 days".
                Visits: how often the Hub was opened. The website and the app count separately, as does each browser.
              </Text>
            </>
          )}
        </View>

        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.heading, { color: colors.text }]}>Privacy</Text>
          <Text style={[styles.note, { color: colors.secondaryText }]}>
            Your wallets, NFTs, names and stars stay on this device. For the user count, once you've added a
            wallet, the Hub sends a random ID (not linked to you or your wallets) each time it's opened, together
            with "website/app" and the version. Nothing else is sent.
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
  statRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowLabel: { width: 56, fontSize: 13, fontWeight: '700' },
  statCell: { flex: 1, textAlign: 'center' },
  statValue: { fontSize: 22, fontWeight: '700' },
  statLabel: { fontSize: 12 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  button: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8 },
  buttonText: { fontSize: 15, fontWeight: '700' },
});
