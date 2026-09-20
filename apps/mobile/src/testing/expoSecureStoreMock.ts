const values = new Map<string, string>();

export const getItemAsync = (key: string) => Promise.resolve(values.get(key) ?? null);
export const setItemAsync = (key: string, value: string) => {
  values.set(key, value);
  return Promise.resolve();
};
