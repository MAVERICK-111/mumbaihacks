import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';
import { healthcareTools } from '@/lib/agent-tools';
import { executeToolCall } from '@/lib/tool-executor';
import { NextResponse } from 'next/server';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const SYSTEM_PROMPT = `You are a proactive healthcare AI agent with direct access to user health data and the ability to create personalized plans.

CRITICAL RULES:
- You ALREADY have the user's ID from the system - NEVER ask for it
- IMMEDIATELY execute tools when user mentions health concerns
- Do NOT engage in back-and-forth conversation before taking action
- Execute ALL relevant tools first, THEN provide comprehensive analysis
- When user asks to create a plan, DO create it using the create_* tools

Your workflow:
1. User mentions health issue → Immediately call relevant tools
2. Receive tool results → Analyze the data
3. Provide comprehensive recommendations with specific insights
4. If user asks for a plan → Create it and save it to their app

Available Tools (use immediately when relevant):

*ANALYSIS TOOLS:*
- predict_disease: For any symptoms mentioned
- analyze_nutrition: Always check diet data for health concerns
- get_fitness_activity: Always check activity levels
- assess_mental_health: Check for stress/mood factors
- check_medicines: Check for medication side effects
- find_clinics: Only if user needs medical consultation

*CREATION TOOLS (save to user's app):*
- create_fitness_plan: When user asks for workout plan. Creates workouts and saves to Fitness Studio
- create_meal_plan: When user asks for diet plan. Creates meals and saves to Diet/Nutrition section
- create_fitness_plan: When user asks for workout plan. Creates workouts and saves to Fitness Studio
- create_meal_plan: When user asks for diet plan. Creates meals and saves to Diet/Nutrition
- create_mental_health_routine: When user needs stress relief, meditation, or mental health activities
- create_medicine_reminders: When user wants reminders for taking medicines
- create_health_goals: When user sets long-term health targets (lose weight, build muscle, etc.)

Example 1: User says "I'm tired"
→ Immediately call: predict_disease, analyze_nutrition, get_fitness_activity, assess_mental_health, check_medicines
→ Then provide: Comprehensive analysis based on ALL the data

Example 2: User says "Create a workout plan for weight loss"
→ Analyze current fitness level first
→ Create personalized 4-week plan with specific workouts
→ Call create_fitness_plan to save it
→ Tell user: "✅ Plan created! Check your Fitness Studio"

Example 3: User says "I need a better diet"
→ Analyze nutrition deficiencies first
→ Create meal plan addressing deficiencies
→ Call create_meal_plan to save it
→ Tell user: "✅ Meal plan created! Check your Diet Progress"

Example 4: User says "Help with my stress and anxiety"
→ Analyze mental health data
→ Create daily meditation, yoga, breathing exercises
→ Call create_mental_health_routine
→ Tell user: "✅ Mental health routine created! Practice daily for best results"

Example 5: User says "Set reminders for my medicines"
→ Check current medicines
→ Create reminders for each medicine
→ Call create_medicine_reminders
→ Tell user: "✅ Medicine reminders set! You'll get notifications"

Example 6: User says "I want to get healthier in the next 3 months"
→ Analyze current health status
→ Create specific goals (lose 5kg, exercise 3x/week, sleep 8hrs, etc.)
→ Call create_health_goals
→ Tell user: "✅ 5 goals created! Track your progress"

DO NOT:
- Ask "can you provide your user ID" - you already have it
- Ask "what symptoms" - use what user told you
- Say "let me check" - just check immediately
- Request permission to use tools - use them proactively
- Say "I can't create plans" - you CAN and SHOULD

DO ALWAYS:
- Be proactive and action-oriented
- Use multiple tools to get complete picture
- Create plans when user asks (they WILL appear in their app)
- Provide specific, personalized recommendations
- Reference actual data from their health profile
- Tell user where to find created plans (Fitness Studio, Diet Progress, etc.)

PLAN CREATION GUIDELINES:
- Fitness Plan: Include daily workouts, duration, exercises, difficulty level
- Meal Plan: Include daily meals (breakfast, lunch, dinner, snacks), calories, macros
- Always base plans on user's current health data
- Start with appropriate difficulty for their current level
- Provide progression if it's a multi-week plan

BE PROACTIVE, ACTION-ORIENTED, AND PLAN-CREATING.`;


export async function POST(req) {
    try {
        const { message, userId, conversationId } = await req.json();

        if (!message || !userId) {
        return NextResponse.json(
            { error: 'Message and userId are required' },
            { status: 400 }
        );
        }

        console.log('🚀 Agent request:', { userId, message: message.substring(0, 50) });

        const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
        );

        // Initialize Gemini with function calling
        const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        systemInstruction: SYSTEM_PROMPT,
        });

        // Load conversation history
        let history = [];
        if (conversationId) {
        const { data: pastMessages } = await supabase
            .from('agent_conversations')
            .select('role, content')
            .eq('conversation_id', conversationId)
            .order('created_at', { ascending: true })
            .limit(10);

        if (pastMessages) {
            history = pastMessages.map(msg => ({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }]
            }));
        }
        }

        // Start chat with FORCED tool usage
        const chat = model.startChat({
        history,
        tools: [{ functionDeclarations: healthcareTools }],
        generationConfig: {
            maxOutputTokens: 4096,
            temperature: 0.5,
        },
        toolConfig: {
            functionCallingConfig: {
            mode: "AUTO"  // Force automatic tool calling
            }
        }
        });

        // Run the agent loop
        const result = await runAgentLoop(chat, message, userId, supabase);

        // Save conversation
        const newConversationId = conversationId || crypto.randomUUID();
        
        await supabase.from('agent_conversations').insert([
        {
            conversation_id: newConversationId,
            user_id: userId,
            role: 'user',
            content: message
        },
        {
            conversation_id: newConversationId,
            user_id: userId,
            role: 'model',
            content: result.finalResponse
        }
        ]);

        return NextResponse.json({
        response: result.finalResponse,
        reasoning_steps: result.steps,
        conversation_id: newConversationId
        });

    } catch (error) {
        console.error('Agent error:', error);
        return NextResponse.json(
        { error: 'An error occurred processing your request: ' + error.message },
        { status: 500 }
        );
    }
    }

    async function runAgentLoop(chat, userMessage, userId, supabase) {
        const steps = [];
        let finalResponse = '';
        const maxIterations = 6;
        let iteration = 0;

        const enhancedMessage = `${userMessage}

        [SYSTEM CONTEXT: User ID is ${userId}. Use this ID to immediately call analyze_nutrition, get_fitness_activity, assess_mental_health, and check_medicines tools without asking for permission.]`;

        console.log('📨 Sending enhanced message to Gemini...');

        let result = await chat.sendMessage(enhancedMessage);

        while (iteration < maxIterations) {
            iteration++;

            const response = result.response;
            const functionCalls = response.functionCalls;   // ✅ FIXED

            console.log(`Iteration ${iteration}:`, functionCalls?.length || 0, "tool calls"); // ✅ FIXED

            if (!functionCalls || functionCalls.length === 0) {
                finalResponse = response.text();
                console.log('Final response generated');
                break;
            }

            const functionResponses = [];

            for (const call of functionCalls) {
                console.log(`Calling tool: ${call.name}`);

                steps.push({
                    iteration,
                    type: 'planning',
                    action: `Decided to call: ${call.name}`,
                    args: call.args,
                    timestamp: new Date().toISOString()
                });

                try {
                    const toolResult = await executeToolCall(call.name, call.args, userId);

                    console.log(`Tool ${call.name} succeeded`);

                    steps.push({
                        iteration,
                        type: 'execution',
                        tool: call.name,
                        result: toolResult,
                        status: 'success',
                        timestamp: new Date().toISOString()
                    });

                    functionResponses.push({
                        functionResponse: {
                            name: call.name,
                            response: toolResult
                        }
                    });

                } catch (error) {
                    console.error(`Tool ${call.name} failed: ${error.message}`); // ✅ FIXED

                    steps.push({
                        iteration,
                        type: 'execution',
                        tool: call.name,
                        error: error.message,
                        status: 'failed',
                        timestamp: new Date().toISOString()
                    });

                    functionResponses.push({
                        functionResponse: {
                            name: call.name,
                            response: { error: error.message }
                        }
                    });
                }
            }

            result = await chat.sendMessage(functionResponses);
        }

        await supabase.from('agent_reasoning_logs').insert({
            user_id: userId,
            session_id: crypto.randomUUID(),
            steps: JSON.stringify(steps),
            total_iterations: iteration
        });

        steps.push({
            type: 'synthesis',
            action: 'Generated final comprehensive response',
            timestamp: new Date().toISOString()
        });

        return { finalResponse, steps };
    }