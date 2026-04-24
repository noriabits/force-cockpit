export const input = {
  parseLines(text: string, fields: string[]): Record<string, string>[] {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const parts = line.split(',');
        const obj: Record<string, string> = {};
        fields.forEach((field, i) => {
          obj[field] = (parts[i] ?? '').trim();
        });
        return obj;
      });
  },
};
