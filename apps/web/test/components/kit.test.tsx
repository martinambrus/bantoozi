import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement, useState, type ComponentType, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';

import { Badge } from '../../src/components/badge.js';
import { Button } from '../../src/components/button.js';
import { Checkbox } from '../../src/components/checkbox.js';
import { IconButton } from '../../src/components/icon-button.js';
import * as icons from '../../src/components/icons.js';
import { SegmentedControl } from '../../src/components/segmented-control.js';
import { Select } from '../../src/components/select.js';
import { Spinner } from '../../src/components/spinner.js';
import { Switch } from '../../src/components/switch.js';
import { TextArea } from '../../src/components/text-area.js';
import { TextField } from '../../src/components/text-field.js';
import { VisuallyHidden } from '../../src/components/visually-hidden.js';
import { createI18n } from '../../src/i18n/index.js';

function renderUi(ui: ReactNode) {
  return render(<I18nextProvider i18n={createI18n('en')}>{ui}</I18nextProvider>);
}

describe('Button', () => {
  it('is a plain button by default and keeps a 44 px target in every size', () => {
    renderUi(
      <>
        <Button size="sm">Small</Button>
        <Button>Medium</Button>
        <Button size="lg">Large</Button>
      </>,
    );
    for (const name of ['Small', 'Medium', 'Large']) {
      const button = screen.getByRole('button', { name });
      expect(button).toHaveAttribute('type', 'button');
      expect(button).toHaveClass('min-h-11');
    }
  });

  it('is primary unless told otherwise and exposes the variant', () => {
    renderUi(
      <>
        <Button>Default</Button>
        {(['primary', 'secondary', 'ghost', 'danger'] as const).map((variant) => (
          <Button key={variant} variant={variant}>
            {variant}
          </Button>
        ))}
      </>,
    );
    expect(screen.getByRole('button', { name: 'Default' })).toHaveAttribute(
      'data-variant',
      'primary',
    );
    for (const variant of ['primary', 'secondary', 'ghost', 'danger']) {
      expect(screen.getByRole('button', { name: variant })).toHaveAttribute(
        'data-variant',
        variant,
      );
    }
  });

  it('has a focus ring', () => {
    renderUi(<Button>Save</Button>);
    expect(screen.getByRole('button').className).toMatch(/focus-visible:outline/);
  });

  it('is disabled and busy while loading, and keeps its name', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderUi(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('is not busy otherwise, and forwards clicks, type and ref', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    let element: HTMLButtonElement | null = null;
    renderUi(
      <Button
        type="submit"
        onClick={onClick}
        ref={(node) => {
          element = node;
        }}
      >
        Go
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Go' });
    expect(button).not.toHaveAttribute('aria-busy');
    expect(button).toHaveAttribute('type', 'submit');
    expect(element).toBe(button);
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('IconButton', () => {
  it('is named by its label, hides its icon and is at least 44 by 44 px', () => {
    renderUi(
      <IconButton label="Close">
        <icons.CloseIcon />
      </IconButton>,
    );
    const button = screen.getByRole('button', { name: 'Close' });
    expect(button).toHaveAttribute('aria-label', 'Close');
    expect(button).toHaveClass('min-h-11', 'min-w-11');
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe.each([
  ['TextField', (props: object) => <TextField label="Name" {...props} />],
  ['TextArea', (props: object) => <TextArea label="Name" {...props} />],
  [
    'Select',
    (props: object) => (
      <Select label="Name" {...props}>
        <option value="a">A</option>
      </Select>
    ),
  ],
])('%s', (_name, renderField) => {
  const control = () => screen.getByLabelText('Name');

  it('is labelled', () => {
    renderUi(renderField({}));
    expect(control()).toBeInTheDocument();
    expect(control()).not.toHaveAttribute('aria-invalid');
    expect(control()).not.toHaveAccessibleDescription();
  });

  it('describes itself with its hint', () => {
    renderUi(renderField({ hint: 'As on your card' }));
    expect(control()).toHaveAccessibleDescription('As on your card');
    expect(control()).not.toHaveAttribute('aria-invalid');
  });

  it('is invalid and described by its error, after the hint', () => {
    renderUi(renderField({ hint: 'As on your card', error: 'Name is required' }));
    expect(control()).toHaveAttribute('aria-invalid', 'true');
    expect(control()).toHaveAccessibleDescription('As on your card Name is required');
    expect(screen.getByText('Name is required')).toBeVisible();
  });

  it('keeps a given id and gives different fields different ids', () => {
    renderUi(
      <>
        {renderField({ id: 'custom' })}
        <TextField label="Other" />
        <TextField label="Another" />
      </>,
    );
    expect(control()).toHaveAttribute('id', 'custom');
    const ids = [screen.getByLabelText('Other').id, screen.getByLabelText('Another').id];
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain('');
  });

  it('is at least 44 px high', () => {
    renderUi(renderField({}));
    expect(control()).toHaveClass('min-h-11');
  });
});

describe('Checkbox', () => {
  it('is a labelled checkbox with description and invalid state', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderUi(
      <Checkbox
        label="Hide read items"
        hint="Only in the list"
        error="Pick one"
        onChange={onChange}
      />,
    );
    const checkbox = screen.getByRole('checkbox', { name: 'Hide read items' });
    expect(checkbox).toHaveAccessibleDescription('Only in the list Pick one');
    expect(checkbox).toHaveAttribute('aria-invalid', 'true');
    await user.click(screen.getByText('Hide read items'));
    expect(checkbox).toBeChecked();
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('Switch', () => {
  function Harness({ onChange = () => {} }: { onChange?: (checked: boolean) => void }) {
    const [checked, setChecked] = useState(false);
    return (
      <Switch
        label="Simple mode"
        hint="Hides the reason bar"
        checked={checked}
        onCheckedChange={(next) => {
          onChange(next);
          setChecked(next);
        }}
      />
    );
  }

  it('is a switch that toggles with click and Space', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderUi(<Harness onChange={onChange} />);
    const toggle = screen.getByRole('switch', { name: 'Simple mode' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toHaveAccessibleDescription('Hides the reason bar');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(onChange).toHaveBeenLastCalledWith(true);

    toggle.focus();
    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('toggles from its label too', async () => {
    const user = userEvent.setup();
    renderUi(<Harness />);
    await user.click(screen.getByText('Simple mode'));
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('does nothing when disabled', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    renderUi(<Switch label="Locked" checked={false} onCheckedChange={onCheckedChange} disabled />);
    const toggle = screen.getByRole('switch', { name: 'Locked' });
    expect(toggle).toBeDisabled();
    await user.click(toggle);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it('is invalid with an error', () => {
    renderUi(
      <Switch label="Needed" checked={false} onCheckedChange={() => {}} error="Turn it on" />,
    );
    const toggle = screen.getByRole('switch', { name: 'Needed' });
    expect(toggle).toHaveAttribute('aria-invalid', 'true');
    expect(toggle).toHaveAccessibleDescription('Turn it on');
  });
});

describe('SegmentedControl', () => {
  const options = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light', disabled: true },
    { value: 'dark', label: 'Dark' },
  ];

  function Harness({ initial = 'system' }: { initial?: string }) {
    const [value, setValue] = useState(initial);
    return (
      <SegmentedControl
        label="Theme"
        hint="Follows your device by default"
        options={options}
        value={value}
        onValueChange={setValue}
      />
    );
  }

  const radio = (name: string) => screen.getByRole('radio', { name });

  it('is a labelled radio group with the selected option checked', () => {
    renderUi(<Harness />);
    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    expect(group).toHaveAccessibleDescription('Follows your device by default');
    expect(radio('System')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Dark')).toHaveAttribute('aria-checked', 'false');
    expect(radio('Light')).toBeDisabled();
  });

  it('has one tab stop, on the selected option', () => {
    renderUi(<Harness initial="dark" />);
    expect(radio('Dark')).toHaveAttribute('tabindex', '0');
    expect(radio('System')).toHaveAttribute('tabindex', '-1');
  });

  it('selects on click', async () => {
    const user = userEvent.setup();
    renderUi(<Harness />);
    await user.click(radio('Dark'));
    expect(radio('Dark')).toHaveAttribute('aria-checked', 'true');
    expect(radio('System')).toHaveAttribute('aria-checked', 'false');
  });

  it('moves the selection and focus with the arrow keys, skipping disabled options and wrapping', async () => {
    const user = userEvent.setup();
    renderUi(<Harness />);
    radio('System').focus();

    await user.keyboard('{ArrowRight}');
    expect(radio('Dark')).toHaveFocus();
    expect(radio('Dark')).toHaveAttribute('aria-checked', 'true');

    await user.keyboard('{ArrowRight}');
    expect(radio('System')).toHaveFocus();
    expect(radio('System')).toHaveAttribute('aria-checked', 'true');

    await user.keyboard('{ArrowLeft}');
    expect(radio('Dark')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(radio('System')).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(radio('Dark')).toHaveFocus();
  });

  it('reports a change only when another option is chosen', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderUi(
      <SegmentedControl
        label="Theme"
        options={options}
        value="system"
        onValueChange={onValueChange}
      />,
    );

    await user.click(radio('System'));
    radio('System').focus();
    await user.keyboard('{Home}');
    expect(onValueChange).not.toHaveBeenCalled();

    await user.click(radio('Dark'));
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith('dark');
  });

  it('jumps to the first and last enabled option with Home and End', async () => {
    const user = userEvent.setup();
    renderUi(<Harness initial="dark" />);
    radio('Dark').focus();
    await user.keyboard('{Home}');
    expect(radio('System')).toHaveFocus();
    expect(radio('System')).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{End}');
    expect(radio('Dark')).toHaveFocus();
    expect(radio('Dark')).toHaveAttribute('aria-checked', 'true');
  });
});

describe('Badge, Spinner and VisuallyHidden', () => {
  it('Badge shows its text, whatever the tone', () => {
    renderUi(
      <>
        <Badge>Neutral</Badge>
        {(['info', 'success', 'warning', 'danger'] as const).map((tone) => (
          <Badge key={tone} tone={tone}>
            {tone}
          </Badge>
        ))}
      </>,
    );
    expect(screen.getByText('Neutral')).toBeVisible();
    for (const tone of ['info', 'success', 'warning', 'danger']) {
      expect(screen.getByText(tone)).toHaveAttribute('data-tone', tone);
    }
  });

  it('Spinner is decorative', () => {
    const { container } = renderUi(<Spinner />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('VisuallyHidden keeps its text for assistive technology only', () => {
    renderUi(
      <button type="button">
        <VisuallyHidden>Delete</VisuallyHidden>
      </button>,
    );
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.getByText('Delete')).toHaveClass('sr-only');
  });
});

describe('icons', () => {
  const REQUIRED = [
    'MenuIcon',
    'CloseIcon',
    'CheckIcon',
    'ChevronUpIcon',
    'ChevronDownIcon',
    'ChevronLeftIcon',
    'ChevronRightIcon',
    'MoreIcon',
    'ThumbsUpIcon',
    'ThumbsDownIcon',
    'BookmarkIcon',
    'BookmarkFilledIcon',
    'TagIcon',
    'EyeOffIcon',
    'UndoIcon',
    'InfoIcon',
    'WarningIcon',
    'ExternalIcon',
    'SearchIcon',
    'PlusIcon',
    'TrashIcon',
    'DragIcon',
    'RefreshIcon',
    'OfflineIcon',
    'SunIcon',
    'MoonIcon',
  ];

  const components = Object.entries(icons) as [string, ComponentType<{ className?: string }>][];

  it('provides every icon the screens need', () => {
    expect(components.map(([name]) => name).sort()).toEqual([...REQUIRED].sort());
  });

  it.each(components)('%s is a decorative inline SVG in the current colour', (_name, Icon) => {
    const { container } = render(createElement(Icon, { className: 'size-6' }));
    const svg = container.querySelector('svg');
    if (svg === null) throw new Error('no svg rendered');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
    expect(svg).toHaveClass('size-6');
    const paints = [svg, ...svg.querySelectorAll('*')]
      .flatMap((element) => [element.getAttribute('stroke'), element.getAttribute('fill')])
      .filter((paint): paint is string => paint !== null && paint !== 'none');
    expect(paints.length).toBeGreaterThan(0);
    expect(new Set(paints)).toEqual(new Set(['currentColor']));
  });
});
