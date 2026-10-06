import { ConsoleShell } from '../_components/ConsoleShell';

/** Signed-in console pages share the shell (session check, navigation, top bar). */
export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}
