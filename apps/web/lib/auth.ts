"use client";

import { create } from "zustand";
import { get, post, tokens } from "./api";
import type { Me, User } from "./types";

interface AuthState {
  me: Me | null;
  ready: boolean;
  load: () => Promise<Me | null>;
  login: (email: string, password: string) => Promise<User>;
  logout: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  me: null,
  ready: false,
  async load() {
    if (!tokens.access()) {
      set({ me: null, ready: true });
      return null;
    }
    try {
      const me = await get<Me>("/auth/me");
      set({ me, ready: true });
      return me;
    } catch {
      set({ me: null, ready: true });
      return null;
    }
  },
  async login(email, password) {
    const res = await post<{ access_token: string; refresh_token: string; user: User }>("/auth/login", { email, password });
    tokens.save(res.access_token, res.refresh_token);
    const me = await get<Me>("/auth/me");
    set({ me, ready: true });
    return res.user;
  },
  logout() {
    tokens.clear();
    set({ me: null });
    location.href = "/login";
  },
}));
