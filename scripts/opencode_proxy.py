#!/usr/bin/env python3
"""OpenCode Go streaming proxy. Requires: pip install aiohttp"""
import argparse
import asyncio
import logging
import os
import uuid

from aiohttp import ClientSession, ClientTimeout, web

HOP_HEADERS = {
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
}


def filtered_headers(headers):
    excluded = HOP_HEADERS | {
        value.strip().lower() for value in headers.get('Connection', '').split(',')
    }
    return {key: value for key, value in headers.items() if key.lower() not in excluded}


def create_app(upstream, api_key=None, per_request=False):
    app = web.Application(client_max_size=64 * 1024 * 1024)
    fallback_session = str(uuid.uuid4())

    async def lifecycle(app):
        async with ClientSession(
            timeout=ClientTimeout(total=None, sock_connect=30),
            auto_decompress=True,
        ) as client:
            app['client'] = client
            yield

    app.cleanup_ctx.append(lifecycle)

    async def proxy(request):
        headers = filtered_headers(request.headers)
        # Do not negotiate compression on behalf of clients that cannot decode it.
        # aiohttp also decompresses incoming request bodies automatically.
        headers = {k: v for k, v in headers.items()
                   if k.lower() not in {'accept-encoding', 'content-encoding'}}
        headers['Accept-Encoding'] = 'identity'
        if not request.headers.get('x-opencode-session'):
            headers['x-opencode-session'] = (
                str(uuid.uuid4()) if per_request else fallback_session
            )
        if api_key:
            # Replace incoming authorization with the configured upstream key.
            headers = {k: v for k, v in headers.items() if k.lower() != 'authorization'}
            headers['Authorization'] = f'Bearer {api_key}'
        headers = {k: v for k, v in headers.items() if k.lower() != 'user-agent'}
        headers['User-Agent'] = 'opencode-session-proxy/1.0'
        target = upstream.rstrip('/') + request.rel_url.raw_path_qs
        response = None
        try:
            async with request.app['client'].request(
                request.method, target, headers=headers,
                data=request.content.iter_any(), allow_redirects=False,
            ) as upstream_response:
                response_headers = filtered_headers(upstream_response.headers)
                # ClientSession decodes these encodings while streaming. Remove
                # their metadata so downstream clients do not decode a second time.
                if upstream_response.headers.get('Content-Encoding', '').lower() in {
                    'gzip', 'deflate', 'br'
                }:
                    response_headers = {k: v for k, v in response_headers.items()
                                        if k.lower() != 'content-encoding'}
                response = web.StreamResponse(
                    status=upstream_response.status,
                    headers=response_headers,
                )
                try:
                    await response.prepare(request)
                except ConnectionError:
                    response.force_close()
                    return response
                async for chunk in upstream_response.content.iter_any():
                    try:
                        await response.write(chunk)
                    except ConnectionError:
                        logging.getLogger(__name__).info('Downstream disconnected; stopping upstream stream')
                        response.force_close()
                        return response
                try:
                    await response.write_eof()
                except ConnectionError:
                    response.force_close()
                return response
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if response is not None and response.prepared:
                # Do not append JSON to a partially transmitted SSE response.
                if request.transport:
                    request.transport.close()
                return response
            return web.json_response(
                {'error': 'Upstream connection failed', 'type': type(exc).__name__},
                status=502,
            )

    app.router.add_route('*', '/{path:.*}', proxy)
    return app


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=12581)
    parser.add_argument('--upstream', default='https://opencode.ai/zen/go')
    parser.add_argument('--random-per-request', action='store_true',
                        help='Generate a new fallback ID for every request instead of per process')
    args = parser.parse_args()
    web.run_app(create_app(args.upstream, os.getenv('OPENCODE_API_KEY'),
                           args.random_per_request),
                host=args.host, port=args.port, access_log=None)
