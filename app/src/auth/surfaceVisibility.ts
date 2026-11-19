import { createContext, useContext } from 'react';

/**
 * False while an authenticator sheet plays its close animation. AuthHost keeps a closed sheet
 * mounted for that long, so its Sheet can slide away instead of vanishing.
 */
export const SurfaceVisibleContext = createContext(true);

export function useSurfaceVisible(): boolean {
  return useContext(SurfaceVisibleContext);
}
