/** CSS Modules のクラス名を、条件つきでつなぐ。false と undefined は無視する。 */
export function classNames(...names: (string | false | undefined)[]): string {
  return names.filter((name) => name !== false && name !== undefined).join(' ');
}
