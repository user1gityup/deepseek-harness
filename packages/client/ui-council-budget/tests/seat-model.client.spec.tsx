// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CouncilBudget, type CouncilBudgetProps } from '../src/client/CouncilBudget.tsx'
import { freeChatModelIds, seatsFrom } from '../src/client/capacity.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const LISTING = {
  data: [
    { id: 'paid/model', pricing: { prompt: '0.000001', completion: '0.000002' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
    { id: 'free/chat:free', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
    { id: 'free/music', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['audio'] } },
    { id: 'unpriced/model', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  ],
}

function mount(section: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => LISTING })))
  const set = vi.fn(async () => {})
  const snapshot = { value: section }
  const settings = { getSnapshot: () => snapshot, subscribe: () => () => {}, set }
  const list = { ids: [], byId: {} }
  const sessions = { list: { subscribe: () => () => {}, getSnapshot: () => list } }
  const props = { wide: true, t: (key: string) => key, settings, sessions } as unknown as CouncilBudgetProps
  render(<CouncilBudget {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'trigger.aria' }))
  return set
}

it('offers only free text chat models, the proxy\'s own filter', () => {
  expect(freeChatModelIds(LISTING.data)).toEqual(['free/chat:free'])
})

it('pins the OpenRouter free seat to one free model', async () => {
  const set = mount({ seats: { 'openrouter-free': { enabled: true } } })
  const select = screen.getByRole('combobox', { name: 'OpenRouter Free seats.model' }) as HTMLSelectElement
  expect(select.value).toBe('')
  await waitFor(() => { expect(screen.getByRole('option', { name: 'free/chat:free' })).toBeTruthy() })
  expect(screen.queryByRole('option', { name: 'free/music' })).toBeNull()
  fireEvent.change(select, { target: { value: 'free/chat:free' } })
  expect(set).toHaveBeenCalledWith('seats', { 'openrouter-free': { enabled: true, model: 'free/chat:free' } })
})

it('puts the OpenRouter free seat back on the rolling route', () => {
  const set = mount({ seats: { 'openrouter-free': { model: 'free/chat:free' } } })
  const select = screen.getByRole('combobox', { name: 'OpenRouter Free seats.model' }) as HTMLSelectElement
  expect(select.value).toBe('free/chat:free')
  fireEvent.change(select, { target: { value: '' } })
  expect(set).toHaveBeenCalledWith('seats', { 'openrouter-free': { model: '' } })
})

it('lets the Codex seat choose among the models Codex lists', () => {
  const set = mount({ seats: {}, codexModels: ['gpt-5.5', 'gpt-6-astra'] })
  const select = screen.getByRole('combobox', { name: 'OpenAI seats.model' }) as HTMLSelectElement
  expect([...select.options].map(option => option.value)).toEqual(['', 'gpt-5.5', 'gpt-6-astra'])
  fireEvent.change(select, { target: { value: 'gpt-6-astra' } })
  expect(set).toHaveBeenCalledWith('seats', { openai: { model: 'gpt-6-astra' } })
})

it('reads an empty model override as the seat default', () => {
  const seat = seatsFrom({ seats: { 'openrouter-free': { model: '' } } }).find(entry => entry.id === 'openrouter-free')
  expect(seat?.model).toBe('proxy-auto')
})
