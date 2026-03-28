import { isUrlProjectId } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ProjectScanner } from "../projects/scanner.js";
import type { ShellService } from "../services/ShellService.js";

export interface ShellRoutesDeps {
  scanner: ProjectScanner;
  shellService: ShellService;
}

export function createShellRoutes(deps: ShellRoutesDeps): Hono {
  const routes = new Hono();

  routes.get("/", (c) => {
    return c.json({ shells: deps.shellService.listShells() });
  });

  routes.post("/", async (c) => {
    let body: { projectId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.projectId || !isUrlProjectId(body.projectId)) {
      return c.json({ error: "Valid projectId is required" }, 400);
    }

    const project = await deps.scanner.getOrCreateProject(body.projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const shell = deps.shellService.createShell({
      projectId: project.id,
      projectName: project.name,
      cwd: project.path,
    });
    return c.json({ shell });
  });

  routes.get("/:shellId", (c) => {
    const shell = deps.shellService.getShell(c.req.param("shellId"));
    if (!shell) {
      return c.json({ error: "Shell not found" }, 404);
    }
    return c.json({ shell });
  });

  routes.get("/:shellId/output", (c) => {
    const afterSeq = Number.parseInt(c.req.query("after") ?? "0", 10) || 0;
    const result = deps.shellService.readOutput(
      c.req.param("shellId"),
      afterSeq,
    );
    if (!result) {
      return c.json({ error: "Shell not found" }, 404);
    }
    return c.json(result);
  });

  routes.get("/:shellId/stream", (c) => {
    const shellId = c.req.param("shellId");
    const shell = deps.shellService.getShell(shellId);
    if (!shell) {
      return c.json({ error: "Shell not found" }, 404);
    }

    const afterSeq = Number.parseInt(c.req.query("after") ?? "0", 10) || 0;
    const replay = deps.shellService.readOutput(shellId, afterSeq);

    return streamSSE(c, async (stream) => {
      let closed = false;
      const unsubscribe = deps.shellService.subscribe(shellId, (chunk) => {
        if (closed) return;
        void stream.writeSSE({
          event: "output",
          id: String(chunk.seq),
          data: JSON.stringify(chunk),
        });
      });

      if (!unsubscribe) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: "Shell not found" }),
        });
        return;
      }

      try {
        for (const chunk of replay?.chunks ?? []) {
          await stream.writeSSE({
            event: "output",
            id: String(chunk.seq),
            data: JSON.stringify(chunk),
          });
        }

        await stream.writeSSE({
          event: "ready",
          data: JSON.stringify({ shellId, state: shell.state }),
        });

        while (!closed) {
          if (deps.shellService.getShell(shellId)?.state !== "running") {
            await stream.writeSSE({
              event: "done",
              data: JSON.stringify({ shellId }),
            });
            break;
          }
          await stream.sleep(1000);
        }
      } finally {
        closed = true;
        unsubscribe();
      }
    });
  });

  routes.post("/:shellId/input", async (c) => {
    let body: { data?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (typeof body.data !== "string") {
      return c.json({ error: "data is required" }, 400);
    }

    const ok = deps.shellService.writeInput(c.req.param("shellId"), body.data);
    if (!ok) {
      return c.json({ error: "Shell not found or not running" }, 404);
    }

    return c.json({ ok: true });
  });

  routes.post("/:shellId/resize", async (c) => {
    let body: { cols?: number; rows?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (
      typeof body.cols !== "number" ||
      !Number.isFinite(body.cols) ||
      typeof body.rows !== "number" ||
      !Number.isFinite(body.rows)
    ) {
      return c.json({ error: "cols and rows are required" }, 400);
    }

    const ok = deps.shellService.resize(
      c.req.param("shellId"),
      body.cols,
      body.rows,
    );
    if (!ok) {
      return c.json({ error: "Shell not found or not running" }, 404);
    }

    return c.json({ ok: true });
  });

  routes.delete("/:shellId", (c) => {
    const ok = deps.shellService.closeShell(c.req.param("shellId"));
    if (!ok) {
      return c.json({ error: "Shell not found" }, 404);
    }
    return c.json({ ok: true });
  });

  return routes;
}
