/** Wrap technical identifiers (IPs, MACs, ports, units) in Unicode LRI…PDI so RTL Arabic prose never reverses them. */
export const ltr = (s: string | number): string => `\u2066${String(s)}\u2069`;
