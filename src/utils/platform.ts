const getPlatform = () => {
  try {
    return window.electronAPI?.getPlatform() || "linux"; // Default to linux if API is not available
  } catch {
    return "linux"; // Default to linux if there's an error
  }
};

// Platform-specific command key symbol
export const COMMAND_KEY = getPlatform() === "darwin" ? "⌘" : "Ctrl";

// Helper to check if we're on Windows
export const isWindows = getPlatform() === "win32";

// Helper to check if we're on macOS
export const isMacOS = getPlatform() === "darwin";

// Helper to check if we're on Linux
export const isLinux = getPlatform() === "linux";
