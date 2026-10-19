export function looksLikeChallengePage(text: string, title = ''): boolean {
  const challenge =
    /^(?:#+\s*)?(?:just a moment|attention required|access denied|verify you are human|checking your browser|security checkpoint|enable javascript and cookies to continue|please enable javascript|why have i been blocked|403 forbidden|404 not found|page not found|subscribe to continue reading|sign in to continue)/i;
  const continuationGate = /^(?:#{1,6}\s*)?to continue reading, choose an option below\.?\s*$/im;
  const subscriptionOption =
    /^(?:#{1,6}\s*)?(?:unlimited access|subscribe to|create your free account)\b/im;
  const subscribersOnly =
    /^(?:#{1,6}\s*)?this article is for (?:\*{1,2})?subscribers only(?:\*{1,2})?\.?\s*$/im;
  const freeTrialGate = /^#{1,6}[ \t]+continue with a free trial[ \t]*$/im;
  const unlockArticle = /^or create a free account to unlock just this article[ \t]*$/im;
  const membershipCaptchaShell =
    !/^#{1,6}[ \t]+\S/m.test(text) &&
    /^Become a Member in Seconds[ \t]*$/m.test(text) &&
    /^An account already exists for this email address, please log in\.[ \t]*$/m.test(text) &&
    /^Chargebee\s+hCaptcha\s+hCaptcha\s+Please try again\.[^\n]*\s+Verify(?:\s|$)/m.test(text) &&
    /https:\/\/(?:www\.)?hcaptcha\.com\/what-is-hcaptcha-about\?[^)\s]*\bref=js\.chargebee\.com(?:[&)])/.test(
      text,
    );
  return (
    challenge.test(title.trim()) ||
    challenge.test(text.trim()) ||
    (continuationGate.test(text) && subscriptionOption.test(text)) ||
    subscribersOnly.test(text) ||
    (freeTrialGate.test(text) && unlockArticle.test(text)) ||
    membershipCaptchaShell
  );
}

export function withoutMediumResponses(text: string): string {
  const byline =
    /https:\/\/(?:[a-z0-9-]+\.)?medium\.com\/[^)\s]*[?&]source=post_page---byline--([a-f0-9]{12})(?:-|[&)])/i.exec(
      text,
    );
  if (!byline) return text;
  const responseLink = new RegExp(
    `[?&]source=(?:post_page)?---post_responses--${byline[1]}(?:-|[&)]|$)`,
    'i',
  );
  for (const section of text.matchAll(/^#{1,6}[ \t]+Responses(?:[ \t]+\(\d+\))?[ \t]*$/gm)) {
    if (
      section.index > byline.index &&
      responseLink.test(text.slice(section.index, section.index + 4096))
    )
      return text.slice(0, section.index).trimEnd();
  }
  return text;
}

export function withoutReutersFooter(text: string, source: URL): string {
  if (source.hostname !== 'reuters.com' && !source.hostname.endsWith('.reuters.com')) return text;
  const footer = [
    ...text.matchAll(
      /^Our Standards: \[The Thomson Reuters Trust Principles[^\n]*\]\(https:\/\/(?:www\.)?thomsonreuters\.com\/en\/about-us\/trust-principles\.html\)[ \t]*$/gm,
    ),
  ].at(-1);
  if (
    footer &&
    /(?:Reporting|Editing) by [^\n]+/.test(text.slice(0, footer.index)) &&
    /^#{1,6}[ \t]+Read Next[ \t]*$/m.test(text.slice(footer.index))
  )
    return text.slice(0, footer.index).trimEnd();
  return text;
}
