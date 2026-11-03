/* Search the displayed session metadata locally; queries never leave the browser. */
window.sessionMatches = (session, query, providerLabel) => {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const text = [session.name, session.projectLabel, session.project, session.folder, session.provider, providerLabel, session.model]
    .filter(value => typeof value === "string").join(" ").toLocaleLowerCase();
  return terms.every(term => text.includes(term));
};
