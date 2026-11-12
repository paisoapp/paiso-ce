import { Link } from "react-router-dom";
import { AuthShell } from "@/components/auth/AuthShell";
import { usePageTitle } from "@/lib/pageTitle";

/** The command a self-hosted install resets a password with. Paiso sends no
 *  email here, so the person who runs the server resets it from the shell. */
const RESET_COMMAND = "docker exec -it paiso-ce python -m app.cli reset-password you@example.com";

export function ForgotPasswordPage() {
  usePageTitle("section", "Forgot password");

  return (
    <AuthShell backdrop="gradient">
      <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>

      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          This copy of Paiso is self-hosted and sends no email, so it cannot send a
          reset link. Reset the password from the command line instead:
        </p>
        <pre className="overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 text-xs text-foreground">
          <code>{RESET_COMMAND}</code>
        </pre>
        <p>
          Use your own address in place of you@example.com. The command asks for the new password.
          The installation guide covers it, and how to reset two-factor sign-in the same way.
        </p>
      </div>

      <p className="text-center text-sm text-muted-foreground">
        Remembered it?{" "}
        <Link to="/login" className="text-primary hover:underline font-medium">Sign in</Link>
      </p>
    </AuthShell>
  );
}
