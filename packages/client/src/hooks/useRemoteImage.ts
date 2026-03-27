import { useEffect, useRef, useState } from "react";
import { getGlobalConnection, isRemoteMode } from "../lib/connection";

interface RemoteImageResult {
  /** URL to use for the image src (either direct path or blob URL) */
  url: string | null;
  /** Whether the image is currently loading */
  loading: boolean;
  /** Error message if loading failed */
  error: string | null;
}

/**
 * Hook for loading images that may need to be fetched via relay in remote mode.
 *
 * In remote mode (when connected through a relay like staging.yepanywhere.com),
 * direct HTTP requests to /api/... will 404 because the static site doesn't have
 * API endpoints. This hook fetches the image via the WebSocket relay and creates
 * a blob URL for display.
 *
 * In direct mode (localhost/LAN), it simply returns the original URL.
 *
 * @param apiPath - The API path for the image (e.g., "/api/projects/.../upload/image.png")
 * @returns Object with url, loading state, and error
 */
export function useRemoteImage(apiPath: string | null): RemoteImageResult {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Use ref to track blob URL for cleanup without triggering re-renders
  const blobUrlRef = useRef<string | null>(null);

  // Check if we're in remote mode
  const remoteMode = isRemoteMode();

  // Fetch image via relay when in remote mode
  useEffect(() => {
    if (!apiPath) {
      // Cleanup previous blob URL
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      setBlobUrl(null);
      setError(null);
      return;
    }

    if (!remoteMode) {
      // Not in remote mode - no need to fetch, just use direct URL
      return;
    }

    const connection = getGlobalConnection();
    if (!connection) {
      setError("No connection available");
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    // Revoke previous blob URL before creating new one
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
      setBlobUrl(null);
    }

    connection
      .fetchBlob(apiPath)
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setBlobUrl(url);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[useRemoteImage] Failed to fetch image:", err);
        setError(err instanceof Error ? err.message : "Failed to load image");
        setLoading(false);
      });

    return () => {
      cancelled = true;
      // Cleanup blob URL on effect cleanup
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [apiPath, remoteMode]);

  // In direct mode, return the path directly; in remote mode, return blob URL
  if (!apiPath) {
    return { url: null, loading: false, error: null };
  }

  if (!remoteMode) {
    // Direct mode: just use the API path as URL
    return { url: apiPath, loading: false, error: null };
  }

  // Remote mode: return blob URL (or null while loading)
  return { url: blobUrl, loading, error };
}

/**
 * Hook that always fetches images via XHR and returns a blob URL.
 * Unlike useRemoteImage, this fetches in both direct and remote modes,
 * ensuring auth headers/cookies are included (important for endpoints
 * that require authentication like /api/local-image).
 */
export function useFetchedImage(apiPath: string | null): RemoteImageResult {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  const remoteMode = isRemoteMode();

  useEffect(() => {
    if (!apiPath) {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      setBlobUrl(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
      setBlobUrl(null);
    }

    const fetchImage = remoteMode
      ? (() => {
          const connection = getGlobalConnection();
          if (!connection)
            return Promise.reject(new Error("No connection available"));
          return connection.fetchBlob(apiPath);
        })()
      : fetch(apiPath, { credentials: "include" }).then((res) => {
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
          return res.blob();
        });

    fetchImage
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setBlobUrl(url);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[useFetchedImage] Failed to fetch image:", err);
        setError(err instanceof Error ? err.message : "Failed to load image");
        setLoading(false);
      });

    return () => {
      cancelled = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [apiPath, remoteMode]);

  if (!apiPath) {
    return { url: null, loading: false, error: null };
  }

  return { url: blobUrl, loading, error };
}

/**
 * Preload an image via relay and return its blob URL.
 * Useful for programmatic image loading outside of React components.
 *
 * @param apiPath - The API path for the image
 * @returns Promise resolving to blob URL, or the original path if not in remote mode
 */
export async function preloadRemoteImage(
  apiPath: string,
): Promise<string | null> {
  if (!isRemoteMode()) {
    // Direct mode: return path as-is
    return apiPath;
  }

  const connection = getGlobalConnection();
  if (!connection) {
    throw new Error("No connection available");
  }

  const blob = await connection.fetchBlob(apiPath);
  return URL.createObjectURL(blob);
}
