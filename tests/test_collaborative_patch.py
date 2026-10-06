"""Exercise server patch handling without opening ports or writing board files."""
import ast
import asyncio
import copy
import json
from pathlib import Path
import unittest
import uuid


class Disconnected(Exception):
    pass


class CollaborativePatchTest(unittest.TestCase):
    def setUp(self):
        tree = ast.parse(Path('whiteboard/server.py').read_text())
        names = {'apply_board_patch', 'websocket_endpoint'}
        functions = [node for node in ast.walk(tree)
                     if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
        for node in functions:
            node.decorator_list = []
        self.sent = []

        async def broadcast(message, exclude=None):
            self.sent.append(copy.deepcopy(message))

        self.scope = dict(current_board_elements=[], connected_clients={},
                          schedule_save_elements=lambda: None, broadcast=broadcast,
                          json=json, uuid=uuid, WebSocket=object, WebSocketDisconnect=Disconnected)
        exec(compile(ast.Module(body=functions, type_ignores=[]), 'server.py', 'exec'), self.scope)

    def patch(self, element_id, before, after):
        return self.scope['apply_board_patch']([dict(id=element_id, before=before, after=after)])

    def test_interleaved_additions_and_undo(self):
        a, b = {'id': 'a'}, {'id': 'b'}
        self.patch('a', None, a)
        self.patch('b', None, b)
        self.patch('a', a, None)
        self.assertEqual(self.scope['current_board_elements'], [b])

    def test_stale_undo_cannot_remove_remote_edit(self):
        original, edited = {'id': 'a', 'x': 0}, {'id': 'a', 'x': 20}
        self.patch('a', None, original)
        self.patch('a', original, edited)
        correction = self.patch('a', original, None)
        self.assertEqual(self.scope['current_board_elements'], [edited])
        self.assertEqual(correction[0]['after'], edited)

    def test_websocket_applies_patch_and_echoes_canonical_result(self):
        incoming = [json.dumps({'type': 'board_patch', 'changes': [
            {'id': 'a', 'before': None, 'after': {'id': 'a'}}]})]

        class Socket:
            async def accept(self):
                pass

            async def send_text(self, text):
                pass

            async def receive_text(self):
                if incoming:
                    return incoming.pop(0)
                raise Disconnected()

        asyncio.run(self.scope['websocket_endpoint'](Socket()))
        patches = [msg for msg in self.sent if msg['type'] == 'board_patch']
        self.assertEqual(len(patches), 1)
        self.assertEqual(patches[0]['changes'][0]['after'], {'id': 'a'})
        self.assertEqual(self.scope['current_board_elements'], [{'id': 'a'}])


if __name__ == '__main__':
    unittest.main()
