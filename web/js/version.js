export const shouldReload = (current, incoming, editing) => Boolean(current && incoming && current !== incoming && !editing);
