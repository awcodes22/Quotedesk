import express from "express";
import type { Request, Response } from "express";

function handleHealthCheck(_request: Request, response: Response): void {
  response.json({ ok: true });
}

export const app = express();

app.get("/health", handleHealthCheck);
