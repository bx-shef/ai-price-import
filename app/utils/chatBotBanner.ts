/**
 * Should the app warn the admin that chat messages are signed by an employee (#360)?
 *
 * Pure so the four conditions can be tested at all — inline in a template they could only be checked
 * by mounting the whole page against a live portal. Each one earns its place:
 *
 *  • `screen === 'work'` — on the setup screen the admin is told to configure the app first; a second
 *    banner about message authorship there is noise stacked on a blocker;
 *  • `isAdmin` — an ordinary employee cannot change the portal's plan or re-grant rights, so for them
 *    this is an alarm they can do nothing about;
 *  • `notifyChatId` — with no chat configured NOTHING is posted, so there is no wrong signature to
 *    warn about. This is the condition most likely to be dropped as «лишняя», and dropping it makes
 *    the banner appear on portals that never send a single message;
 *  • `botReady` — fail-open: the flag defaults to «есть», so a transient read failure keeps quiet
 *    instead of accusing a healthy portal.
 */
export function shouldWarnUnsignedChat(input: {
  screen: string
  isAdmin: boolean
  botReady: boolean
  notifyChatId?: string | null
}): boolean {
  return input.screen === 'work' && input.isAdmin && !input.botReady && !!input.notifyChatId
}
