import React, { useState, useEffect, useCallback } from 'react';

import { Box, Text, useApp, Static } from 'ink';
import Header from './components/Header.js';
import Message from './components/Message.js';
import Input from './components/Input.js';
import TreeAnimation from './components/TreeAnimation.js';
import { sendMessageStream, rejectChange } from './api/chat.js';
import { useSocket } from './contexts/SocketContext.js';
import { getWorkspaceInfo } from './utils/workspace.js';
import { useWorkspace } from './contexts/WorkspaceContext.js';
import SelectInput from 'ink-select-input';
import { sendProjectFiles } from './api/graph.js';


type MessageItem = {
	role: 'user' | 'model';
	text: string;
	edit: boolean;
};

export default function App() {
	const {exit} = useApp();
	const { socket, isConnected, isConnecting, connectionError, tool } = useSocket();
	const { setWorkspace } = useWorkspace();
	const [messages, setMessages] = useState<MessageItem[]>([]);
	const [workspaceSelected, setWorkspaceSelected] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [mode, setMode] = useState<string | null>(null);
	const [pendingReview, setPendingReview] = useState(false);
	const modes = [
		{
			label: 'Chat', 
			value: 'chat'
		}, 
		{
			label: 'Agent', 
			value: 'agent'
		}
	]

	const [showAnimation, setShowAnimation] = useState(true);
	const [streamingMessage, setStreamingMessage] = useState<string>('');
	const [thinkingDots, setThinkingDots] = useState<string>('.');

	useEffect(() => {
		if (!isLoading) return;

		const interval = setInterval(() => {
			setThinkingDots((prev) => {
				if (prev === '.') return '..';
				if (prev === '..') return '...';
				return '.';
			});
		}, 500);

		return () => clearInterval(interval);
	}, [isLoading]);

	const handleAnimationComplete = useCallback(() => {
		setShowAnimation(false);
	}, []);

	const reviewChoices = [
		{ label: '✅ Accept changes', value: 'accept' },
		{ label: '❌ Reject changes', value: 'reject' },
	];

	const handleReviewSelect = async (item: { value: string }) => {
		if (item.value === 'accept') {
			setMessages((prev) => [...prev, { role: 'model', text: 'Changes accepted.', edit: false }]);
			setPendingReview(false);
		} else if (item.value === 'reject') {
			if (!socket || !isConnected || !socket.id || !sessionId) {
				setMessages((prev) => [...prev, { role: 'model', text: 'Cannot reject: not connected or no active session.', edit: false }]);
				setPendingReview(false);
				return;
			}
			try {
				const res = await rejectChange(socket.id, sessionId);
				setMessages((prev) => [...prev, { role: 'model', text: res.response, edit: false }]);
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : 'Unknown error occurred';
				setMessages((prev) => [...prev, { role: 'model', text: `Error rejecting changes: ${message}`, edit: false }]);
			}
			setPendingReview(false);
		}
	};

	const welcomeMessage = 'Start you session by entering the path to your repository';

	useEffect(() => {
		setMessages([{role: 'model', text: welcomeMessage, edit: false}]);
	}, []); // Only run once on mount

	const handleSubmit = async (text: string) => {
		if (text === '/help') {
			const helpText = `Available commands:
• /help - Show this help message
• /clear - Clear conversation
• /quit - Leave current session and reset workspace
• /exit - Exit the application
• /agent - Switch to agent mode
• /chat - Switch to chat mode`;
			setMessages((prev) => [...prev, {role: 'model', text: helpText, edit: false}]);
		}

		if (text === '/exit') {
			exit();
			socket?.disconnect()
			return;
		}

		if (text === '/clear') {
			setMessages([]);
			return;
		}

		if (text === '/quit') {
			setSessionId(null);
			setWorkspace(process.cwd());
			setWorkspaceSelected(false);
			setMessages([{role: 'model', text: welcomeMessage, edit: false}]);
			return;
		}

		setMessages((prev) => [...prev, {role: 'user', text, edit: false}]);

		if (!workspaceSelected) {
			try {
				const info = await getWorkspaceInfo(text);
				if (!info.exists) {
					setMessages((prev) => [...prev, {role: 'model', text: 'Directory does not exist. Please enter a valid project directory path.', edit: false}]);
				} else if (!info.isDirectory) {
					setMessages((prev) => [...prev, {role: 'model', text: 'Path exists but is not a directory. Please enter a valid project directory path.', edit: false}]);
				} else if (!socket || !isConnected || !socket.id) {
					setMessages((prev) => [...prev, {role: 'model', text: 'Backend is not connected yet. Check the API terminal and try again.', edit: false}]);
				} else {
					setWorkspace(info.absolutePath);
					setUploading(true);
					try {
						const result = await sendProjectFiles(socket.id, info.absolutePath);
						setWorkspaceSelected(true);
						setMessages((prev) => [...prev, {
							role: 'model',
							text: 'Workspace set to: ' + info.absolutePath + '\nIndexed ' + result.files_processed + ' files. You can start chatting now.',
							edit: false
						}]);
					} finally {
						setUploading(false);
					}
				}
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : 'Unknown error occurred';
				setMessages((prev) => [...prev, {role: 'model', text: 'Workspace setup failed: ' + message, edit: false}]);
			}
			return;
		}
		setIsLoading(true);
		setError(null);

		if (!socket || !isConnected || !socket.id) {
			setMessages((prev) => [...prev, {role: 'model', text: 'Failed to connect to server', edit: false}]);
			return;
		}

		try {
			// Add empty message placeholder for streaming response
			setStreamingMessage('');
			
			const stream = await sendMessageStream(text, socket.id, mode!, sessionId || undefined);
			const reader = stream.getReader();
			const decoder = new TextDecoder();
			let currentSessionId = sessionId;
			let edit = false;
			let accumulatedMessage = '';
			let buffer = '';

			const processEvent = (event: string) => {
				for (const line of event.split(/\r?\n/)) {
					if (!line.startsWith('data: ')) continue;
					const data = line.slice(6);
					if (data === '[DONE]') continue;

					const parsed = JSON.parse(data) as {
						session_id?: string;
						edit?: boolean;
						chunk?: string;
						error?: string;
					};
					if (parsed.error) {
						throw new Error(parsed.error);
					}
					if (parsed.session_id) {
						currentSessionId = parsed.session_id;
						edit = Boolean(parsed.edit);
						if (!sessionId) setSessionId(currentSessionId);
					} else if (typeof parsed.chunk === 'string') {
						accumulatedMessage = parsed.chunk;
						setStreamingMessage(accumulatedMessage);
					}
				}
			};

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				let boundary = buffer.indexOf('\n\n');
				while (boundary !== -1) {
					const event = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					if (event.trim()) processEvent(event);
					boundary = buffer.indexOf('\n\n');
				}
			}

			buffer += decoder.decode();
			if (buffer.trim()) processEvent(buffer);

			// Finalize the message
			setMessages((prev) => [...prev, {role: 'model', text: accumulatedMessage, edit}]);
			setStreamingMessage('');
			if (edit) setPendingReview(true);
		} catch (err: unknown) {
			const message =
				err instanceof Error ? err.message : 'Unknown error occurred';
			setError(`Error: ${message}`);
		} finally {
			setIsLoading(false);
		}
	};
	if (showAnimation) {
		return <TreeAnimation onComplete={handleAnimationComplete} />;
	}
	return (
		<Box flexDirection="column" padding={1}>
			<Header />
			{(!mode) && (
				<SelectInput items={modes} onSelect={m => setMode(m.value)} />
			)}
			{(mode) && (
				<>
					<Static items={messages}>
						{(msg, i) => (
							<Message key={i} role={msg.role} text={msg.text} edit={msg.edit} />
						)}
					</Static>
					{streamingMessage && (
						<Message role="model" text={streamingMessage} edit={false} />
					)}
					{isLoading && !streamingMessage && (
						<Message role="model" text={`Thinking${thinkingDots}`} edit={false} />
					)}
				</>
			)}
			{(error || connectionError) && (
				<Box marginTop={1}>
					<Text color="red">{error || connectionError}</Text>
				</Box>
			)}
			{isConnecting && (
				<Box marginTop={1}>
					<Text color="yellow">Connecting to server...</Text>
				</Box>
			)}
			{!isConnected && !isConnecting && !connectionError && (
				<Box marginTop={1}>
					<Text color="gray">Disconnected from server</Text>
				</Box>
			)}
			{uploading && (
				<Box marginTop={1}>
					<Text color="yellow">Uploading files...</Text>
				</Box>
			)}
			{tool && (
				<Box marginTop={1}>
					<Text color="gray" dimColor>{tool}</Text>
				</Box>
			)}
			{mode && pendingReview && (
				<Box flexDirection="column" marginTop={1}>
					<Text color="yellow" bold>Review changes — accept or reject?</Text>
					<SelectInput items={reviewChoices} onSelect={handleReviewSelect} />
				</Box>
			)}
			{mode && !pendingReview && !isLoading && (
				<Box marginTop={1}>
					<Input onSubmit={handleSubmit} isLoading={isLoading} mode={mode} />
				</Box>
			)}
		</Box>
	);
}
