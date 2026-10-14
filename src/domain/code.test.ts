import { describe, expect, it } from 'vitest';
import { codePreview, detectCodeLanguage } from './code';
import { classify, makeClip } from './library';

describe('local language detection', () => {
  it.each([
    ['sql', '/* TEST IN TASK: byt sender */\r\n-- kommentar\r\nselect Name from dbo.Users where Id = 1;'],
    ['sql', 'DECLARE @name nvarchar(80);\nINSERT INTO dbo.Users (Name) VALUES (@name);'],
    ['powershell', '#Requires -Modules VMware.PowerCLI\r\nparam([string]$Server)\r\nGet-VM | Select-Object Name'],
    ['typescript', 'const greeting = (name: string) => { return name; };'],
    ['javascript', 'const greeting = (name) => { return name; };'],
    ['python', 'def greet(name):\n    return name'],
    ['bash', '#!/usr/bin/env bash\nNAME="Copyloom"\necho "$NAME"'],
    ['csharp', 'using System;\npublic class App { }'],
    ['java', 'package example;\npublic class App { }'],
    ['rust', 'pub fn greet(name: &str) -> String { name.into() }'],
    ['go', 'package main\nfunc main() { println("Hi") }'],
    ['xml', '<section><h1>Hello</h1></section>'],
    ['css', '.card { color: red; padding: 12px; }'],
    ['json', '{"name":"Copyloom","enabled":true}'],
    ['yaml', 'name: Copyloom\nsettings:\n  enabled: true'],
    ['php', '<?php\n$greeting = "Hello";'],
  ])('recognizes %s without changing the copied content', (language, content) => {
    expect(detectCodeLanguage(content)).toBe(language);
    expect(classify(content)).toBe('code');
    expect(makeClip(content).content).toBe(content);
  });
  it.each([
    'Hej, här kommer en anteckning.', 'Det kostar $100.',
    'You can select a value from the dropdown.', 'SQL and PowerShell are useful.',
    'Namn: Magnus\nTelefon: kontakta växeln', '/* select * from dbo.Users */',
    '// const name = "example";', 'public class Example { }', 'return value;',
  ])('does not guess a language for ambiguous text: %s', content => {
    expect(detectCodeLanguage(content)).toBeUndefined();
  });
  it('bounds inspection of a large clip', () => {
    expect(detectCodeLanguage('An ordinary note.\n'.repeat(2000) + 'SELECT * FROM dbo.Users;')).toBeUndefined();
  });
});

it('shows code after a long introductory comment without altering the original', () => {
  const content = '/*\nTitle\n====================\nDescription\nMore explanation\n*/\nSELECT * FROM dbo.Users;';
  expect(codePreview(content)).toBe('/* … */\nSELECT * FROM dbo.Users;');
  expect(makeClip(content).content).toBe(content);
  expect(codePreview('/* short */\nSELECT 1;')).toBe('/* short */\nSELECT 1;');
  expect(codePreview(content).length).toBeLessThanOrEqual(5000);
});
