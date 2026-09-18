/**
 * ThemeContext.js
 *
 * Holds which color theme (light or dark) is currently active, and hands
 * it to any component that calls the useTheme() hook below - so a deeply
 * nested component like NftCard can get the right colors without every
 * file in between having to pass them down as a prop.
 *
 * This is a manual toggle the person controls (the button in App.js) -
 * it does NOT follow the phone's own system-wide appearance setting.
 * That's a deliberate simplicity choice, not an oversight; if you'd
 * rather it start out matching the phone's system setting, React
 * Native's own useColorScheme() hook would give you that starting value.
 */

import { createContext, useContext, useMemo, useState } from 'react';
import { lightColors, darkColors } from '../constants/theme';

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  // Starts in dark mode by default, per feedback - still just the same
  // manual toggle either way (the button in App.js), this only changes
  // which mode the app opens in before you've touched that button.
  const [isDark, setIsDark] = useState(true);

  const value = useMemo(() => {
    const colors = isDark ? darkColors : lightColors;
    return {
      isDark,
      colors,
      toggleTheme: () => setIsDark((previous) => !previous),
    };
  }, [isDark]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme() must be called from inside a <ThemeProvider>.');
  }
  return context;
}
