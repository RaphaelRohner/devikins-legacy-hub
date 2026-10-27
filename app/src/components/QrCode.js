/**
 * QrCode.js - draws a QR code with plain boxes (27 Oct 2026; the same way
 * as the KLV Signer's Receive screen), so it looks the same on the website
 * and in the Android app. Used to link another device to the chat. The QR
 * maths comes from `qrcode-generator` (MIT licence, no dependencies of its
 * own, pinned exactly in package.json) and runs on this device.
 */
import { useMemo } from 'react';
import { View } from 'react-native';
// Default import on purpose: the phone build loads the library's CommonJS
// file, where the function is the whole export.
import qrcode from 'qrcode-generator';

/** The QR code as rows of dark stretches ([start column, length]). */
export function qrRuns(text) {
  const qr = qrcode(0, 'M'); // 0 = size chosen automatically; M = medium error correction
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const rows = [];
  for (let r = 0; r < n; r += 1) {
    const runs = [];
    let start = -1;
    for (let c = 0; c <= n; c += 1) {
      const dark = c < n && qr.isDark(r, c);
      if (dark && start < 0) start = c;
      if (!dark && start >= 0) {
        runs.push([start, c - start]);
        start = -1;
      }
    }
    rows.push(runs);
  }
  return { size: n, rows };
}

const QUIET = 3; // white border, in squares (scanners need some quiet space)

/** Black on white whatever the theme (scanners read that best). */
export default function QrCode({ text, size = 220, testID, accessibilityLabel = 'QR code' }) {
  const code = useMemo(() => qrRuns(text), [text]);
  const unit = size / (code.size + QUIET * 2);
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      style={{ width: size, height: size, backgroundColor: '#ffffff', position: 'relative' }}
    >
      {code.rows.map((runs, r) => runs.map(([c, len]) => (
        <View
          key={`${r}-${c}`}
          style={{
            position: 'absolute',
            left: (c + QUIET) * unit,
            top: (r + QUIET) * unit,
            width: len * unit + 0.5,
            height: unit + 0.5,
            backgroundColor: '#000000',
          }}
        />
      )))}
    </View>
  );
}
