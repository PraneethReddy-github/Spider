import { type FormEvent, useState } from 'react';
import { type Me, useAuth } from '../auth';

/** Hosted mode sign-in / sign-up (S-4). An `?invite=` code in the address joins that workspace. */
export function AuthScreen() {
  const { signup, firstUser, setSession } = useAuth();
  const invite = new URLSearchParams(window.location.search).get('invite') ?? '';
  const canSignUp = firstUser || signup === 'open' || !!invite;
  const [mode, setMode] = useState<'login' | 'signup'>(firstUser || invite ? 'signup' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const body =
        mode === 'login'
          ? { email, password }
          : { email, password, name, orgName: orgName || undefined, invite: invite || undefined };
      const res = await fetch(`/api/v1/auth/${mode}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as Me & { token?: string; error?: string };
      if (!res.ok || !data.token) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSession(data.token, { user: data.user, orgs: data.orgs });
      // signing in with an invite in the address joins that workspace (App handles it for signed-in users too)
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="home">
      <form className="auth-card" onSubmit={submit}>
        <h1 className="auth-title">Spider</h1>
        <p className="tone-2">
          {firstUser
            ? 'Create the first account. It owns a new workspace and can invite others.'
            : invite
              ? 'You were invited to a workspace. Create an account, or sign in to join it.'
              : 'Sign in to your workspace.'}
        </p>
        {mode === 'signup' && (
          <label className="auth-field">
            <span className="t-caption">Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </label>
        )}
        <label className="auth-field">
          <span className="t-caption">Email</span>
          <input
            className="input"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </label>
        <label className="auth-field">
          <span className="t-caption">Password</span>
          <input
            className="input"
            type="password"
            required
            minLength={mode === 'signup' ? 10 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          />
        </label>
        {mode === 'signup' && !invite && (
          <label className="auth-field">
            <span className="t-caption">Workspace name</span>
            <input
              className="input"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="Optional"
            />
          </label>
        )}
        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
        {canSignUp && !firstUser && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}
          >
            {mode === 'login' ? 'Create an account instead' : 'I have an account'}
          </button>
        )}
      </form>
    </div>
  );
}
