export const SAMPLE = {
  name: 'JSON World',
  version: 1.2,
  active: true,
  owner: null,
  tags: ['viewer', 'editor', 'tree'],
  users: [
    { id: 1, name: 'Ada Lovelace', email: 'ada@example.com', roles: ['admin'], address: { city: 'London', zip: 'NW1' } },
    { id: 2, name: 'Alan Turing', email: 'alan@example.com', roles: ['dev', 'reviewer'], address: { city: 'Wilmslow', zip: 'SK9' } },
    { id: 3, name: 'Grace Hopper', email: 'grace@example.com', roles: [], address: { city: 'Arlington', zip: '22201' } },
  ],
  settings: { theme: 'light', indent: 2, features: { sync: true, undo: true, search: true } },
};
