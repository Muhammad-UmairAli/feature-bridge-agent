import { render, screen, fireEvent } from '@testing-library/react';
import CounterDemo from './demo';

describe('CounterDemo', () => {
  it('displays initial count of 0', () => {
    render(<CounterDemo />);
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('increments count when + button clicked', () => {
    render(<CounterDemo />);
    const incBtn = screen.getByRole('button', { name: 'increment' });
    fireEvent.click(incBtn);
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('decrements count when - button clicked', () => {
    render(<CounterDemo />);
    const decBtn = screen.getByRole('button', { name: 'decrement' });
    fireEvent.click(decBtn);
    expect(screen.getByText('-1')).toBeInTheDocument();
  });

  it('buttons have appropriate aria-labels', () => {
    render(<CounterDemo />);
    const incBtn = screen.getByRole('button', { name: 'increment' });
    const decBtn = screen.getByRole('button', { name: 'decrement' });
    expect(incBtn).toHaveAttribute('aria-label', 'increment');
    expect(decBtn).toHaveAttribute('aria-label', 'decrement');
  });

  it('component is keyboard operable (Enter triggers click)', () => {
    render(<CounterDemo />);
    const incBtn = screen.getByRole('button', { name: 'increment' });
    incBtn.focus();
    fireEvent.keyDown(incBtn, { key: 'Enter', code: 'Enter' });
    fireEvent.keyUp(incBtn, { key: 'Enter', code: 'Enter' });
    expect(screen.getByText('1')).toBeInTheDocument();
  });
});
