// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { KeywordInput } from './KeywordInput';

function Harness({ start = [] as string[] }) {
  const [value, setValue] = useState(start);
  return (
    <>
      <KeywordInput value={value} onChange={setValue} label="关键词" hint="按回车添加" />
      <pre data-testid="value">{JSON.stringify(value)}</pre>
      <button type="button">elsewhere</button>
    </>
  );
}
const value = () => JSON.parse(screen.getByTestId('value').textContent!) as string[];
const field = () => screen.getByLabelText('关键词');

describe('KeywordInput', () => {
  it('adds a keyword on Enter, on a comma, and when leaving the field', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(field(), '适合约会{Enter}');
    await user.type(field(), '很安静，份量大,');
    await user.type(field(), '  环境 好 ');
    await user.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(value()).toEqual(['适合约会', '很安静', '份量大', '环境 好']);
    expect(field()).toHaveValue('');
    const chips = screen.getByRole('list', { name: '已添加的关键词' });
    expect(within(chips).getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByRole('status')).toHaveTextContent('4/10，每个最多 20 字');
  });

  it('never adds a keyword on the Enter that confirms an input method', () => {
    render(<Harness />);
    const input = field();
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '适合' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    // Some browsers end composition first and then send Enter with keyCode 229.
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(value()).toEqual([]);
    expect(input).toHaveValue('适合');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(value()).toEqual(['适合']);
  });

  it('ignores repeats with a note and keeps to the limits', async () => {
    const user = userEvent.setup();
    render(<Harness start={['Quiet']} />);
    await user.type(field(), 'quiet{Enter}');
    expect(value()).toEqual(['Quiet']);
    expect(screen.getByRole('status')).toHaveTextContent('已经添加过「quiet」');
    expect(field()).toHaveAttribute('maxLength', '20');
    await user.click(field());
    await user.paste('1,2,3,4,5,6,7,8,9,10,');
    expect(value()).toHaveLength(10);
    expect(screen.getByRole('status')).toHaveTextContent('最多 10 个关键词');
    expect(field()).toBeDisabled();
    expect(field()).toHaveAttribute('placeholder', '已达到 10 个上限');
  });

  it('removes a keyword with its button or Backspace in the empty field', async () => {
    const user = userEvent.setup();
    render(<Harness start={['a', 'b', 'c']} />);
    await user.click(screen.getByRole('button', { name: '删除关键词「b」' }));
    expect(value()).toEqual(['a', 'c']);
    expect(field()).toHaveFocus();
    await user.keyboard('{Backspace}');
    expect(value()).toEqual(['a']);
    await user.type(field(), 'x{Backspace}');
    expect(value()).toEqual(['a']);
  });

  it('splits pasted lists', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(field());
    await user.paste('实惠、出餐快\n很辣');
    expect(value()).toEqual(['实惠', '出餐快']);
    expect(field()).toHaveValue('很辣');
  });
});
