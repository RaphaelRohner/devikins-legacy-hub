/**
 * QrScannerModal.js
 *
 * Full-screen camera overlay for scanning a Klever wallet address's QR
 * code, opened from WalletManager.js's "Add a wallet" row (the new
 * camera button next to the paste field) as an alternative to typing
 * or pasting the address by hand.
 *
 * Deliberately doesn't add the scanned wallet directly - it just fills
 * the exact same text field a manual paste would (see WalletManager.js's
 * onScanned handler), then closes back to it. The existing Add button,
 * and everything that already happens when it's tapped (the "first
 * wallet ever" heads-up, etc.), runs completely unchanged - scanning
 * only replaces how the address gets into that field, not what happens
 * after. That also means a scan stays visible and editable before it's
 * actually added, which matters here specifically because a real
 * Klever wallet app's QR code was never available to test this against
 * - only assumed to encode the plain address text (see extractAddress
 * below for the fallback if a real scan turns out to look different).
 */

import { useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';

// Klever addresses are bech32 and start "klv1" (see WalletManager.js's
// own placeholder text, "klv1..."). If a scanned QR's raw content
// isn't JUST the bare address - e.g. some wallet apps wrap an address
// in their own URI scheme, like "klever:klv1...?amount=..." - this
// pulls the address back out of that instead of handing the wrapper
// text straight to the Add field untouched. Falls back to the raw
// scanned text (trimmed) if no klv1... pattern is found anywhere in
// it, rather than silently discarding a scan that might still be a
// perfectly valid address in some format not accounted for here.
export function extractAddress(scannedText) {
  const trimmed = scannedText.trim();
  const match = trimmed.match(/klv1[a-z0-9]+/i);
  return match ? match[0] : trimmed;
}

export default function QrScannerModal({ visible, onScanned, onClose }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();

  // CameraView's onBarcodeScanned fires on every camera frame that
  // still sees a recognized code, not just once - without this guard,
  // holding the phone steady on a QR code for even half a second would
  // call onScanned() dozens of times before the modal finishes closing.
  const hasScannedRef = useRef(false);

  useEffect(() => {
    if (visible) {
      hasScannedRef.current = false;
    }
  }, [visible]);

  function handleBarcodeScanned({ data }) {
    if (hasScannedRef.current) return;
    hasScannedRef.current = true;
    onScanned(extractAddress(data));
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        {!permission ? (
          // Permission status hasn't finished loading yet - render
          // nothing rather than flash a "camera access needed" message
          // that's about to be replaced a moment later either way.
          <View style={styles.centerMessage} />
        ) : !permission.granted ? (
          <View style={styles.centerMessage}>
            <Text style={styles.permissionText}>
              {permission.canAskAgain
                ? 'This app needs camera access to scan a QR code.'
                : "Camera access was denied - enable it for this app in your phone's Settings to scan a QR code."}
            </Text>
            {permission.canAskAgain && (
              <TouchableOpacity
                style={[styles.permissionButton, { backgroundColor: colors.primary }]}
                onPress={requestPermission}
              >
                <Text style={[styles.permissionButtonText, { color: colors.primaryText }]}>
                  Allow Camera Access
                </Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          <CameraView
            style={styles.camera}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={handleBarcodeScanned}
          />
        )}

        <TouchableOpacity
          style={[styles.closeButton, { top: insets.top + 12 }]}
          onPress={onClose}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={styles.closeButtonText}>✕</Text>
        </TouchableOpacity>

        {permission?.granted && (
          <View style={[styles.hintBar, { bottom: insets.bottom + 24 }]}>
            <Text style={styles.hintText}>Point the camera at a Klever wallet address QR code</Text>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // Deliberately plain black/white here rather than the app's own
  // theme colors - this sits on top of a live camera feed, not the
  // app's usual background, so it needs to read clearly over whatever
  // is actually in frame rather than match light/dark mode.
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  camera: {
    flex: 1,
  },
  centerMessage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  permissionText: {
    color: '#fff',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 16,
  },
  permissionButton: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
  },
  permissionButtonText: {
    fontSize: 15,
    fontWeight: '700',
  },
  closeButton: {
    position: 'absolute',
    right: 20,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeButtonText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
  },
  hintBar: {
    position: 'absolute',
    left: 20,
    right: 20,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  hintText: {
    color: '#fff',
    fontSize: 14,
    textAlign: 'center',
  },
});
