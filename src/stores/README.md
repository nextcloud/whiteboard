# Zustand Stores

This directory contains global state management using [Zustand](https://github.com/pmndrs/zustand), a small, fast, and scalable state management solution.

## Available Stores

### JWT Store
`jwtStore.ts` - Manages JWT tokens for authentication with the collaboration server.

- **State**:
  - `tokens`: Record mapping roomIds to their JWT tokens
  
- **Actions**:
  - `getJWT(roomId, fileId, publicSharingToken)`: Get a JWT token for a room (from cache or server)
  - `refreshJWT(roomId, fileId, publicSharingToken)`: Force refresh of JWT token from server
  - `clearJWT(roomId)`: Clear JWT token for a specific room
  - `clearAllJWT()`: Clear all JWT tokens

### Network Store
`networkStore.ts` - Manages network status and offline mode settings.

- **State**:
  - `status`: Current network status ('online' or 'offline')
  - `isOfflineMode`: Whether offline mode is enabled (can be manual or auto)
  
- **Actions**:
  - `setStatus(status)`: Update the current network status
  - `toggleOfflineMode()`: Toggle offline mode on/off
  - `setOfflineMode(isOffline)`: Set offline mode to a specific state

### App Store
`appStore.ts` - Manages general application state.

- **State**:
  - `theme`: UI theme ('light' or 'dark')
  - `viewModeEnabled`: Whether view-only mode is enabled
  
- **Actions**:
  - `setTheme(theme)`: Set the UI theme
  - `toggleTheme()`: Toggle between light and dark themes
  - `setViewModeEnabled(enabled)`: Enable or disable view-only mode

## Usage

Import and use the stores directly or via the custom hooks:

```typescript
// Direct usage
import { useJWTStore } from '../stores/jwtStore'

function MyComponent() {
  const { getJWT, refreshJWT } = useJWTStore()
  // ...
}

// Via hooks (recommended)
import { useJWT } from '../hooks/useJWT'
import { useNetwork } from '../hooks/useNetwork'

function MyComponent() {
  const { getJWT, refreshJWT } = useJWT()
  const { networkStatus, isOfflineMode, toggleOfflineMode } = useNetwork()
  // ...
}
```

## Benefits of Zustand

- **Simple API**: Zustand has a minimal and intuitive API
- **Small package size**: Very lightweight compared to alternatives
- **No providers needed**: Access state from anywhere without wrapping your app in providers
- **Performance**: Minimizes re-renders with fine-grained updates
- **Middleware support**: Built-in support for persistence, immer, etc.
- **TypeScript support**: Excellent TypeScript integration 
