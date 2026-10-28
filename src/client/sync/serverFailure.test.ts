import { describe, expect, it } from 'vitest';
import { serverFailureMessage } from './serverFailure';

describe('サーバーが失敗を返したときの知らせの文言（設計書 6.5）', () => {
  it('送信も受け取りも失敗していないときは、知らせない', () => {
    expect(serverFailureMessage({ send: null, receive: null })).toBeNull();
  });

  it('受け取りだけが失敗しているときは、受け取りの HTTP の状態を出す', () => {
    expect(serverFailureMessage({ send: null, receive: 503 })).toBe(
      'サーバーとのやり取りに失敗しています（HTTP 503）。続くときは、Worker のログを確かめてください',
    );
  });

  it('送信だけが失敗しているときは、送信の HTTP の状態を出す', () => {
    expect(serverFailureMessage({ send: 500, receive: null })).toBe(
      'サーバーとのやり取りに失敗しています（HTTP 500）。続くときは、Worker のログを確かめてください',
    );
  });

  it('両方が失敗しているときは、送信の HTTP の状態を出す（保存した編集が、まだ届いていないため）', () => {
    expect(serverFailureMessage({ send: 500, receive: 503 })).toContain('（HTTP 500）');
  });

  it('状態が 200 のとき（応答の形が違う）は、HTTP の状態の代わりに、応答の形が違うと出す', () => {
    expect(serverFailureMessage({ send: 200, receive: null })).toBe(
      'サーバーとのやり取りに失敗しています（応答の形が違います）。続くときは、Worker のログを確かめてください',
    );
  });
});
