/**
 * Remote client entry point.
 *
 * This is a separate entry point for the remote (static) client that:
 * - Uses SecureConnection for all communication (SRP + NaCl encryption)
 * - Shows a login page before connecting
 * - Does NOT use cookie-based auth (uses SRP instead)
 *
 * Route structure:
 * - UnauthenticatedGate: wraps login routes, redirects to app if already connected
 * - ConnectionGate: wraps direct-mode app routes (no relay username in URL)
 * - RelayConnectionGate: wraps relay-mode app routes (/:relayUsername/...)
 *
 * ConnectionGate and RelayConnectionGate share the same APP_ROUTES.
 * This avoids duplicating route definitions or provider wrapping.
 */

console.log("[RemoteClient] Loading remote-main.tsx entry point");

import { Fragment, StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Toggle to disable StrictMode for easier debugging (avoids double renders)
const STRICT_MODE = false;
const Wrapper = STRICT_MODE ? StrictMode : Fragment;

import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ConnectionGate, RemoteApp, UnauthenticatedGate } from "./RemoteApp";
import { initializeFontSize } from "./hooks/useFontSize";
import { initializeTabSize } from "./hooks/useTabSize";
import { initializeTheme } from "./hooks/useTheme";
import { I18nProvider } from "./i18n";
import { NavigationLayout } from "./layouts";
import { ActivityPage } from "./pages/ActivityPage";
import { AgentsPage } from "./pages/AgentsPage";
import { DirectLoginPage } from "./pages/DirectLoginPage";
import { EmulatorPage } from "./pages/EmulatorPage";
import { FilePage } from "./pages/FilePage";
import { GitStatusPage } from "./pages/GitStatusPage";
import { GlobalSessionsPage } from "./pages/GlobalSessionsPage";
import { HostPickerPage } from "./pages/HostPickerPage";
import { InboxPage } from "./pages/InboxPage";
import { NewSessionPage } from "./pages/NewSessionPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { RelayConnectionGate } from "./pages/RelayConnectionGate";
import { RelayLoginPage } from "./pages/RelayLoginPage";
import { SessionPage } from "./pages/SessionPage";
import { ShellPage } from "./pages/ShellPage";
import { ShellsPage } from "./pages/ShellsPage";
import { SettingsLayout } from "./pages/settings";
import "./styles/index.css";

// Apply saved preferences before React renders to avoid flash
initializeTheme();
initializeFontSize();
initializeTabSize();

// Get base URL for router (Vite sets this based on --base flag)
// Remove trailing slash for BrowserRouter basename
const basename = import.meta.env.BASE_URL.replace(/\/$/, "") || undefined;

/**
 * Shared app routes used by both direct mode (ConnectionGate) and
 * relay mode (RelayConnectionGate). Uses relative paths so they resolve
 * correctly under both "/" and "/:relayUsername/".
 */
const APP_ROUTES = (
  <>
    <Route index element={<Navigate to="projects" replace />} />

    {/* IMPORTANT: Keep routes in sync with main.tsx — adding a route here? Add it there too! */}
    <Route element={<NavigationLayout />}>
      <Route path="projects" element={<ProjectsPage />} />
      <Route path="sessions" element={<GlobalSessionsPage />} />
      <Route path="agents" element={<AgentsPage />} />
      <Route path="shells" element={<ShellsPage />} />
      <Route path="inbox" element={<InboxPage />} />
      <Route path="git-status" element={<GitStatusPage />} />
      <Route path="devices" element={<EmulatorPage />} />
      <Route path="devices/:deviceId" element={<EmulatorPage />} />
      <Route path="settings" element={<SettingsLayout />} />
      <Route path="settings/:category" element={<SettingsLayout />} />
      <Route path="new-session" element={<NewSessionPage />} />
      <Route path="shells/:shellId" element={<ShellPage />} />
      <Route
        path="projects/:projectId/sessions/:sessionId"
        element={<SessionPage />}
      />
    </Route>

    {/* Pages with custom layouts */}
    <Route path="projects/:projectId/file" element={<FilePage />} />
    <Route path="activity" element={<ActivityPage />} />

    {/* Catch-all redirect to projects (must use ../ to escape splat route's relative resolution) */}
    <Route path="*" element={<Navigate to="../projects" replace />} />
  </>
);

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <Wrapper>
    <BrowserRouter basename={basename}>
      <I18nProvider>
        <RemoteApp>
          <Routes>
            {/* Login routes — redirect to app if already connected */}
            <Route element={<UnauthenticatedGate />}>
              <Route path="/login" element={<HostPickerPage />} />
              <Route path="/login/direct" element={<DirectLoginPage />} />
              <Route path="/login/relay" element={<RelayLoginPage />} />
            </Route>

            {/* Direct mode — requires connection, no relay username in URL */}
            <Route element={<ConnectionGate />}>{APP_ROUTES}</Route>

            {/* Relay mode — manages relay connection by URL username.
                React Router ranks static segments above dynamic params,
                so /projects matches ConnectionGate, not /:relayUsername. */}
            <Route path="/:relayUsername" element={<RelayConnectionGate />}>
              {APP_ROUTES}
            </Route>
          </Routes>
        </RemoteApp>
      </I18nProvider>
    </BrowserRouter>
  </Wrapper>,
);
