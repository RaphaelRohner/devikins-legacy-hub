/**
 * alertForWeb.js
 *
 * On the phone, Alert.alert shows a native pop-up with buttons. In the
 * browser version of React Native, Alert.alert does nothing at all - so
 * messages would silently vanish and "Are you sure?" questions would never
 * get an answer.
 *
 * This file fills that gap on the website only, using the browser's own
 * simple pop-ups:
 *   - a message with zero or one button -> window.alert (just "OK")
 *   - a question with Cancel + one other button -> window.confirm
 *     ("OK" runs the other button, "Cancel" runs Cancel)
 * It's loaded once at start-up from index.js and does nothing on the phone.
 */

import { Alert, Platform } from 'react-native';

if (Platform.OS === 'web' && typeof window !== 'undefined') {
  Alert.alert = (title, message, buttons) => {
    const text = [title, message].filter(Boolean).join('\n\n');
    if (!buttons || buttons.length <= 1) {
      window.alert(text);
      buttons?.[0]?.onPress?.();
      return;
    }
    const cancel = buttons.find((b) => b.style === 'cancel');
    const action = buttons.find((b) => b !== cancel);
    if (window.confirm(text)) {
      action?.onPress?.();
    } else {
      cancel?.onPress?.();
    }
  };
}
