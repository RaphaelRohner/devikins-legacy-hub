/**
 * useKeepFocusedInputVisible.js - when the keyboard opens on a phone, scroll
 * the text field you're typing in into view (26 Oct 2026).
 *
 * Why: the Android app draws edge to edge, so Android doesn't move anything
 * out of the keyboard's way by itself. App.js now shrinks the whole app by the
 * keyboard's height; this hook is the second half: on a long scrolling page
 * (Wallets, Withdrawals) it scrolls so the field sits a little below the top
 * of the visible part. Raphael and a friend found the field being edited on
 * the Wallets page out of view.
 *
 * Use: const scrollRef = useRef(null); useKeepFocusedInputVisible(scrollRef);
 *      <ScrollView ref={scrollRef} ...>
 * Does nothing on the website (browsers do this themselves).
 */
import { useEffect } from 'react';
import { Keyboard, Platform, TextInput } from 'react-native';

const ROOM_ABOVE = 80; // px of the page left visible above the field

export default function useKeepFocusedInputVisible(scrollRef) {
  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    const sub = Keyboard.addListener('keyboardDidShow', () => {
      // (a moment later: the screen has shrunk by then)
      setTimeout(() => {
        const field = TextInput.State?.currentlyFocusedInput?.();
        const scroll = scrollRef.current;
        const content = scroll?.getInnerViewRef?.();
        if (!field || !scroll || !content || typeof field.measureLayout !== 'function') return;
        try {
          field.measureLayout(
            content,
            (x, y) => scroll.scrollTo({ y: Math.max(0, y - ROOM_ABOVE), animated: true }),
            () => {}, // not inside this page's scrolling part: leave it
          );
        } catch (e) {
          // (measuring can fail on an unusual setup: just don't scroll)
        }
      }, 120);
    });
    return () => sub.remove();
  }, [scrollRef]);
}
